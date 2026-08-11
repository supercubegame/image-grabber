// MV3 service worker: the only place that touches chrome.scripting,
// chrome.downloads and chrome.contextMenus. No decision logic here - that belongs
// in src/core/images.js.
import { SETTINGS_KEY, mergeSettings, normalizeCandidates, planDownloads } from '../core/images.js';

const VERSION = '0.2.0';
const CONTENT_SCRIPT = 'src/content/collect.js';
const MENU_ID = 'download-all-images';
const MENU_TITLE = 'Download all images on this page';
// Badge text has room for about four characters; past that it is a smear.
const BADGE_CAP = 99;

// Read-only diagnostic surface for the verification gate.
// Fields may be ADDED, never renamed or removed (see AGENTS.md).
self.__DIAG__ = {
  version: VERSION,
  scans: 0,
  downloads: 0,
  errors: [],
  menuClicks: 0,
  bulkRuns: 0,
  lastBulk: null,
  contextMenu: {
    id: MENU_ID,
    created: false,
    error: null,
    // Computed on read: a menu item whose click goes nowhere looks perfectly fine
    // from the outside, so the gate has to be able to see the listener itself.
    get listenerAttached() {
      return Boolean(chrome.contextMenus && chrome.contextMenus.onClicked.hasListener(onMenuClicked));
    }
  }
};

function recordError(where, message) {
  self.__DIAG__.errors.push(`${where}: ${message}`);
  if (self.__DIAG__.errors.length > 50) self.__DIAG__.errors.shift();
}

self.addEventListener('error', event => recordError('error', event && event.message ? event.message : 'unknown'));
self.addEventListener('unhandledrejection', event => recordError('unhandledrejection', String(event && event.reason)));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => {
      const text = err && err.message ? err.message : String(err);
      recordError('handle:' + (message && message.type), text);
      sendResponse({ ok: false, error: text });
    });
  return true; // keep the channel open for the async response
});

async function handle(message) {
  if (!message || typeof message.type !== 'string') throw new Error('message has no type');
  if (message.type === 'scan') return scan(message.tabId);
  if (message.type === 'download') return download(message.items);
  if (message.type === 'bulk-download') return bulkDownload(message.tabId);
  if (message.type === 'diag') return self.__DIAG__;
  throw new Error('unknown message type: ' + message.type);
}

async function scan(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('scan needs a valid tabId, got ' + tabId);
  const results = await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  const payload = results && results[0] ? results[0].result : null;
  if (!payload || !Array.isArray(payload.candidates)) throw new Error('content script returned no candidates');
  self.__DIAG__.scans += 1;
  return payload;
}

async function download(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('download needs a non-empty item list');
  const ids = [];
  for (const item of items) {
    const id = await chrome.downloads.download({
      url: item.url,
      filename: item.filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    ids.push(id);
  }
  self.__DIAG__.downloads += ids.length;
  return { ids };
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored ? stored[SETTINGS_KEY] : null);
}

// One entry point for both triggers: the right-click menu and the `bulk-download`
// message. Headless Chrome cannot open a native context menu, so the gate drives
// the message path - keeping them a single function is what makes that honest.
//
// Note there is no probing here: a worker has no DOM, so images with no intrinsic
// size stay at 0x0 and a min-size filter will skip them. The popup probes because
// it can (see AGENTS.md).
async function bulkDownload(tabId) {
  const payload = await scan(tabId);
  const items = normalizeCandidates(payload.candidates, payload.pageUrl);
  const settings = await loadSettings();
  const plan = planDownloads(items, settings);
  const result = {
    pageUrl: payload.pageUrl,
    found: items.length,
    planned: plan.length,
    skipped: items.length - plan.length,
    ids: []
  };
  if (plan.length) {
    const queued = await download(plan);
    result.ids = queued.ids;
  }
  self.__DIAG__.bulkRuns += 1;
  self.__DIAG__.lastBulk = result;
  await setBadge(plan.length);
  return result;
}

// The menu is silent by nature - without this the user cannot tell whether the
// click did anything at all.
async function setBadge(count) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#2d7d46' : '#8a8a8a' });
    await chrome.action.setBadgeText({ text: count > BADGE_CAP ? BADGE_CAP + '+' : String(count) });
  } catch (err) {
    recordError('setBadge', err && err.message ? err.message : String(err));
  }
}

function onMenuClicked(info, tab) {
  if (!info || info.menuItemId !== MENU_ID) return;
  self.__DIAG__.menuClicks += 1;
  const tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
  if (tabId === null) {
    recordError('contextMenu', 'click arrived without a tab id');
    return;
  }
  bulkDownload(tabId).catch(err => recordError('contextMenu:bulk', err && err.message ? err.message : String(err)));
}

// removeAll first: the worker is restarted constantly and create() on an id that
// already exists fails with "duplicate id", which would leave a working menu next
// to a permanent error in the diagnostics.
function ensureMenu() {
  if (!chrome.contextMenus) {
    self.__DIAG__.contextMenu.error = 'chrome.contextMenus is unavailable - is the permission declared?';
    return;
  }
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: MENU_TITLE,
        contexts: ['page', 'image'],
        documentUrlPatterns: ['http://*/*', 'https://*/*']
      }, () => {
        const err = chrome.runtime.lastError;
        self.__DIAG__.contextMenu.created = !err;
        self.__DIAG__.contextMenu.error = err ? err.message : null;
        if (err) recordError('contextMenus.create', err.message);
      });
    });
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    self.__DIAG__.contextMenu.error = text;
    recordError('ensureMenu', text);
  }
}

// Listeners must be registered synchronously at the top level or the worker will
// not be woken for the event it is supposed to handle.
if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener(onMenuClicked);
chrome.runtime.onInstalled.addListener(ensureMenu);
ensureMenu();
