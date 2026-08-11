// Popup controller: DOM, storage and messaging only. Anything decision-shaped
// lives in ../core/images.js, ../core/scroll.js and ../core/retry.js so it can be
// unit tested without a browser.
import {
  KNOWN_FORMATS,
  SETTINGS_KEY,
  mergeSettings,
  normalizeCandidates,
  applyFilters,
  planDownloads
} from '../core/images.js';
import { probeDimensions } from './probe.js';

// Coupled with POLL_TIMEOUT_MS in scripts/verify-e2e.js: the gate must wait longer
// than the worst-case probe. Change one, recheck the other (AGENTS.md).
const PROBE_TIMEOUT_MS = 4000;
const PROBE_CONCURRENCY = 6;
const PROGRESS_EVENT_CAP = 300;

const blankProgress = () => ({
  runId: null, total: 0, done: 0, failed: 0, skipped: 0, settled: 0,
  retries: 0, retrying: 0, attempts: 0, ratio: 0, complete: false, text: ''
});

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
  pageUrl: '',
  tabId: null,
  scroll: null,
  download: blankProgress(),
  downloadResult: null,
  // Every progress payload received and every bar width actually painted, in order.
  // The second one is the interesting record: a bar that only shows up once the run
  // is over leaves a single width behind.
  progressEvents: [],
  renderedWidths: []
};

// Read-only diagnostic surface for the verification gate.
// Fields may be ADDED, never renamed or removed (see AGENTS.md).
Object.defineProperty(window, '__DIAG__', {
  value: Object.freeze({
    version: '0.4.0',
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
        scroll: state.scroll,
        download: { ...state.download },
        downloadResult: state.downloadResult,
        progressEvents: state.progressEvents.slice(),
        renderedWidths: state.renderedWidths.slice(),
        settings: {
          minWidth: state.settings.minWidth,
          minHeight: state.settings.minHeight,
          includeDataUrls: state.settings.includeDataUrls,
          formats: state.settings.formats.slice(),
          filenamePrefix: state.settings.filenamePrefix,
          scroll: { ...state.settings.scroll }
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
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored ? stored[SETTINGS_KEY] : null);
}

function saveSettings() {
  return chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
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
  byId('autoScroll').checked = state.settings.scroll.enabled;
  byId('maxImages').value = String(state.settings.scroll.maxImages);
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
  // Auto-scroll changes what the page contains, not how the results are filtered,
  // so it has to rescan. A checkbox that only takes effect the next time the popup
  // opens reads as a broken checkbox.
  byId('autoScroll').addEventListener('change', () => {
    state.settings.scroll.enabled = byId('autoScroll').checked;
    saveSettings().catch(recordError);
    rescan().catch(recordError);
  });
  // The cap only applies to the next scroll run, so this one just persists.
  byId('maxImages').addEventListener('input', () => {
    state.settings.scroll.maxImages = toSize(byId('maxImages').value);
    saveSettings().catch(recordError);
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

// The worker broadcasts progress to every extension page. The popup only LISTENS -
// it must not answer, or it would race the service worker's reply to whoever sent
// the original message.
chrome.runtime.onMessage.addListener(message => {
  if (!message || message.type !== 'download-progress') return;
  onDownloadProgress(message.progress, message.runId);
});

function progressText(p) {
  const parts = [`${p.settled}/${p.total} files`, `${p.done} saved`];
  if (p.retrying > 0) parts.push(`${p.retrying} retrying`);
  else if (p.retries > 0) parts.push(`${p.retries} retried`);
  if (p.failed > 0) parts.push(`${p.failed} failed`);
  return parts.join(' \u00b7 ') + (p.complete ? '' : ' \u2026');
}

function onDownloadProgress(progress, runId) {
  if (!progress || typeof progress.total !== 'number') return;
  // A new run starts a new record. Without this, one run's bar widths would be read
  // as the previous run's and the "it moved" assertion would pass for free.
  if (runId !== undefined && runId !== state.download.runId) {
    state.progressEvents = [];
    state.renderedWidths = [];
  }
  state.download = { runId: runId === undefined ? state.download.runId : runId, ...progress, text: progressText(progress) };
  state.progressEvents.push({ ...progress, runId: state.download.runId });
  if (state.progressEvents.length > PROGRESS_EVENT_CAP) state.progressEvents.shift();
  renderProgress();
}

function renderProgress() {
  const box = byId('progress');
  const bar = byId('progressBar');
  const label = byId('progressText');
  const p = state.download;
  if (!p.total) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const percent = Math.round(Math.min(1, Math.max(0, p.ratio)) * 100);
  bar.style.width = percent + '%';
  bar.classList.toggle('failed', p.failed > 0);
  label.textContent = p.text;
  const last = state.renderedWidths[state.renderedWidths.length - 1];
  if (last !== percent) state.renderedWidths.push(percent);
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

// The banner is the popup's version of the badge "?": if the scroll run gave up,
// the list below it is a partial page and the user has to be told so.
function renderScrollNote() {
  const note = byId('scrollNote');
  const summary = state.scroll;
  if (!summary) {
    note.hidden = true;
    note.textContent = '';
    note.classList.remove('warn');
    return;
  }
  const moved = `${summary.scrolls}\u00d7 scrolled \u00b7 ${summary.imagesAtStart} \u2192 ${summary.imagesAtEnd} images`;
  note.hidden = false;
  note.classList.toggle('warn', summary.reachedEnd !== true);
  note.textContent = summary.reachedEnd
    ? `${moved} \u00b7 reached the end (${summary.outcome})`
    : `${moved} \u00b7 END NOT CONFIRMED (${summary.outcome}) \u2013 there may be more below`;
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
    dims.textContent = `${item.width || '?'}\u00d7${item.height || '?'} \u00b7 ${item.format}`;
    meta.append(name, dims);

    row.append(checkbox, thumb, meta);
    list.append(row);
  }

  byId('empty').hidden = state.visible.length > 0;
  byId('counts').textContent = `${state.selected.size}/${state.visible.length} selected \u00b7 ${state.all.length} found`;
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
  // Same planner the context menu uses: the folder and the naming rules live in
  // the core, not in two places that can drift.
  const items = planDownloads(picked, state.settings);
  setPhase('downloading');
  const response = await send({ type: 'download', items });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : 'download failed');
  const run = response.data;
  state.downloadRequested = items.length;
  state.downloadIds = run.ids || [];
  state.downloadResult = {
    total: run.total, done: run.done, failed: run.failed, skipped: run.skipped,
    retries: run.retries, warning: run.warning
  };
  // Paint the final numbers from the reply as well as from the broadcast: a popup
  // that was busy when the last event arrived would otherwise sit at 90% forever.
  if (run.progress) onDownloadProgress(run.progress, run.runId);
  setPhase('ready');
  byId('status').textContent = run.failed || run.skipped
    ? `${run.done} saved, ${run.failed + run.skipped} failed`
    : `saved ${run.done}`;
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

async function rescan() {
  if (state.tabId === null) throw new Error('rescan before a tab was resolved');
  setPhase(state.settings.scroll.enabled ? 'scrolling' : 'scanning');
  const response = await send({ type: 'scan', tabId: state.tabId, scroll: state.settings.scroll });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : 'scan failed');

  state.pageUrl = response.data.pageUrl;
  state.rawCandidates = response.data.candidates.length;
  state.scroll = response.data.scroll || null;
  state.all = normalizeCandidates(response.data.candidates, response.data.pageUrl);
  renderScrollNote();
  render();

  setPhase('probing');
  await probeUnknown();
  render();
  setPhase('ready');
}

async function main() {
  state.settings = await loadSettings();
  renderFormatFilters();
  syncControls();
  bindEvents();
  render();
  renderProgress();

  // `?tabId=` is a read-only override used by the verification gate; without it the
  // popup targets the active tab exactly as a user would expect.
  const params = new URLSearchParams(location.search);
  state.tabId = params.has('tabId') ? Number(params.get('tabId')) : await activeTabId();

  await rescan();
}

main().catch(recordError);
