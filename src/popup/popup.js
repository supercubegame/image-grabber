// Popup controller: DOM, storage and messaging only. Anything decision-shaped
// lives in ../core/images.js so it can be unit tested without a browser.
import {
  KNOWN_FORMATS,
  mergeSettings,
  normalizeCandidates,
  applyFilters,
  suggestFilename
} from '../core/images.js';
import { probeDimensions } from './probe.js';

// Coupled with POLL_TIMEOUT_MS in scripts/verify-e2e.js: the gate must wait longer
// than the worst-case probe. Change one, recheck the other (AGENTS.md).
const PROBE_TIMEOUT_MS = 4000;
const PROBE_CONCURRENCY = 6;
const DOWNLOAD_FOLDER = 'image-grabber';
const STORAGE_KEY = 'settings';

const state = {
  phase: 'init',
  settings: mergeSettings(null),
  all: [],
  visible: [],
  selected: new Set(),
  rawCandidates: 0,
  probed: 0,
  downloadRequested: 0,
  downloadIds: [],
  errors: [],
  pageUrl: ''
};

// Read-only diagnostic surface for the verification gate.
// Fields may be ADDED, never renamed or removed (see AGENTS.md).
Object.defineProperty(window, '__DIAG__', {
  value: Object.freeze({
    version: '0.1.0',
    get state() {
      return {
        phase: state.phase,
        pageUrl: state.pageUrl,
        rawCandidates: state.rawCandidates,
        scanned: state.all.length,
        visible: state.visible.length,
        selected: state.selected.size,
        renderedRows: document.querySelectorAll('.row').length,
        probed: state.probed,
        downloadRequested: state.downloadRequested,
        downloadIds: state.downloadIds.slice(),
        settings: {
          minWidth: state.settings.minWidth,
          minHeight: state.settings.minHeight,
          includeDataUrls: state.settings.includeDataUrls,
          formats: state.settings.formats.slice(),
          filenamePrefix: state.settings.filenamePrefix
        },
        items: state.all.map(item => ({
          url: item.url,
          width: item.width,
          height: item.height,
          format: item.format,
          occurrences: item.occurrences
        })),
        errors: state.errors.slice()
      };
    }
  }),
  writable: false,
  configurable: false
});

const byId = id => document.getElementById(id);

function setPhase(phase) {
  state.phase = phase;
  byId('status').textContent = phase;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergeSettings(stored ? stored[STORAGE_KEY] : null);
}

function saveSettings() {
  return chrome.storage.local.set({ [STORAGE_KEY]: state.settings });
}

function onSettingsChanged() {
  saveSettings().catch(recordError);
  render();
}

function renderFormatFilters() {
  const box = byId('formats');
  box.textContent = '';
  for (const format of KNOWN_FORMATS) {
    const label = document.createElement('label');
    label.className = 'chk';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'fmt-' + format;
    checkbox.checked = state.settings.formats.includes(format);
    checkbox.addEventListener('change', () => {
      const chosen = new Set(state.settings.formats);
      if (checkbox.checked) chosen.add(format); else chosen.delete(format);
      state.settings.formats = KNOWN_FORMATS.filter(f => chosen.has(f));
      onSettingsChanged();
    });
    label.append(checkbox, document.createTextNode(' ' + format));
    box.append(label);
  }
}

function syncControls() {
  byId('minWidth').value = String(state.settings.minWidth);
  byId('minHeight').value = String(state.settings.minHeight);
  byId('includeDataUrls').checked = state.settings.includeDataUrls;
}

function toSize(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function bindEvents() {
  byId('minWidth').addEventListener('input', () => {
    state.settings.minWidth = toSize(byId('minWidth').value);
    onSettingsChanged();
  });
  byId('minHeight').addEventListener('input', () => {
    state.settings.minHeight = toSize(byId('minHeight').value);
    onSettingsChanged();
  });
  byId('includeDataUrls').addEventListener('change', () => {
    state.settings.includeDataUrls = byId('includeDataUrls').checked;
    onSettingsChanged();
  });
  byId('selectAll').addEventListener('change', () => {
    if (byId('selectAll').checked) for (const item of state.visible) state.selected.add(item.url);
    else state.selected.clear();
    render();
  });
  byId('download').addEventListener('click', () => {
    downloadSelected().catch(recordError);
  });
}

function shortName(url) {
  if (url.startsWith('data:')) return 'inline data URL';
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').pop() || parsed.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function render() {
  state.visible = applyFilters(state.all, state.settings);
  const visibleUrls = new Set(state.visible.map(item => item.url));
  for (const url of Array.from(state.selected)) if (!visibleUrls.has(url)) state.selected.delete(url);
  if (byId('selectAll').checked) for (const item of state.visible) state.selected.add(item.url);

  const list = byId('list');
  list.textContent = '';
  for (const item of state.visible) {
    const row = document.createElement('li');
    row.className = 'row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.url);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.url); else state.selected.delete(item.url);
      render();
    });

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = item.url;
    thumb.alt = '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = shortName(item.url);
    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = `${item.width || '?'}×${item.height || '?'} · ${item.format}`;
    meta.append(name, dims);

    row.append(checkbox, thumb, meta);
    list.append(row);
  }

  byId('empty').hidden = state.visible.length > 0;
  byId('counts').textContent = `${state.selected.size}/${state.visible.length} selected · ${state.all.length} found`;
  byId('download').disabled = state.selected.size === 0;
}

async function probeUnknown() {
  const pending = state.all.filter(item => !item.isData && (!item.width || !item.height));
  let cursor = 0;
  const workers = new Array(Math.min(PROBE_CONCURRENCY, pending.length)).fill(0).map(async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      const size = await probeDimensions(item.url, PROBE_TIMEOUT_MS);
      item.width = size.width;
      item.height = size.height;
      state.probed += 1;
    }
  });
  await Promise.all(workers);
}

async function downloadSelected() {
  const picked = state.visible.filter(item => state.selected.has(item.url));
  if (!picked.length) return;
  const items = picked.map((item, index) => ({
    url: item.url,
    filename: `${DOWNLOAD_FOLDER}/${suggestFilename(item, index, state.settings)}`
  }));
  setPhase('downloading');
  const response = await send({ type: 'download', items });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : 'download failed');
  state.downloadRequested = items.length;
  state.downloadIds = response.data.ids;
  setPhase('ready');
  byId('status').textContent = `queued ${items.length}`;
}

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('no active tab');
  return tabs[0].id;
}

function recordError(err) {
  const message = err && err.message ? err.message : String(err);
  state.errors.push(message);
  state.phase = 'error';
  byId('status').textContent = 'error: ' + message;
}

async function main() {
  state.settings = await loadSettings();
  renderFormatFilters();
  syncControls();
  bindEvents();
  render();
  setPhase('scanning');

  // `?tabId=` is a read-only override used by the verification gate; without it the
  // popup targets the active tab exactly as a user would expect.
  const params = new URLSearchParams(location.search);
  const tabId = params.has('tabId') ? Number(params.get('tabId')) : await activeTabId();

  const response = await send({ type: 'scan', tabId });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : 'scan failed');

  state.pageUrl = response.data.pageUrl;
  state.rawCandidates = response.data.candidates.length;
  state.all = normalizeCandidates(response.data.candidates, response.data.pageUrl);
  render();

  setPhase('probing');
  await probeUnknown();
  render();
  setPhase('ready');
}

main().catch(recordError);
