// MV3 service worker: the only place that touches chrome.scripting,
// chrome.downloads and chrome.contextMenus. No decision logic here - that belongs
// in src/core/images.js and src/core/scroll.js.
import { SETTINGS_KEY, mergeSettings, normalizeCandidates, planDownloads } from '../core/images.js';
import { mergeScrollOptions, initScrollRun, observeScroll, scrollSummary } from '../core/scroll.js';

const VERSION = '0.3.0';
const CONTENT_SCRIPT = 'src/content/collect.js';
const SCROLL_SCRIPT = 'src/content/scroll_step.js';
const MENU_ID = 'download-all-images';
const MENU_TITLE = 'Download all images on this page';
const MENU_ID_SCROLL = 'download-all-images-scrolled';
const MENU_TITLE_SCROLL = 'Scroll to load more, then download all images';
// Badge text has room for about four characters; past that it is a smear.
const BADGE_CAP = 99;
// The state machine always terminates on its own limits; this only catches a bug
// in the state machine itself, which would otherwise be an infinite loop in a
// service worker - the worst possible place for one.
const SCROLL_SAFETY_ROUNDS = 10;

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
  scrollRuns: 0,
  lastScroll: null,
  contextMenu: {
    id: MENU_ID,
    created: false,
    error: null,
    // Computed on read: a menu item whose click goes nowhere looks perfectly fine
    // from the outside, so the gate has to be able to see the listener itself.
    get listenerAttached() {
      return Boolean(chrome.contextMenus && chrome.contextMenus.onClicked.hasListener(onMenuClicked));
    }
  },
  // Added, not folded into the field above: `contextMenu` is part of the frozen
  // diagnostic contract and turning it into an array would break every reader.
  contextMenuScroll: {
    id: MENU_ID_SCROLL,
    created: false,
    error: null,
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
  if (message.type === 'scan') return scan(message.tabId, message.scroll);
  if (message.type === 'download') return download(message.items);
  if (message.type === 'bulk-download') return bulkDownload(message.tabId, message.scroll);
  if (message.type === 'diag') return self.__DIAG__;
  throw new Error('unknown message type: ' + message.type);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drives src/content/scroll_step.js in a loop and feeds every measurement to the
// pure state machine. The worker holds the clock; the criterion, the limits and
// the verdict all live in src/core/scroll.js.
async function autoScroll(tabId, options) {
  const config = mergeScrollOptions(options);
  const startedAt = Date.now();
  const roundCap = config.maxScrolls + SCROLL_SAFETY_ROUNDS;
  let run = initScrollRun(config);

  while (!run.done) {
    const results = await chrome.scripting.executeScript({ target: { tabId }, files: [SCROLL_SCRIPT] });
    const measurement = results && results[0] ? results[0].result : null;
    if (!measurement) throw new Error('the scroll step returned no measurement - was the injection blocked?');
    run = observeScroll(run, measurement, Date.now() - startedAt);
    if (run.done) break;
    if (run.rounds > roundCap) {
      throw new Error(`scroll loop ran ${run.rounds} rounds without a verdict (cap ${roundCap}) - the state machine failed to terminate`);
    }
    if (config.settleMs > 0) await sleep(config.settleMs);
  }

  const summary = scrollSummary(run);
  self.__DIAG__.scrollRuns += 1;
  self.__DIAG__.lastScroll = summary;
  if (summary.warning) recordError('autoScroll', summary.warning);
  return summary;
}

async function scan(tabId, scrollOptions) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('scan needs a valid tabId, got ' + tabId);
  const scrollConfig = mergeScrollOptions(scrollOptions);
  // Scroll first, collect once at the end: collect.js walks the whole DOM, so
  // running it every round would cost far more than it tells us.
  const scroll = scrollConfig.enabled ? await autoScroll(tabId, scrollConfig) : null;
  const results = await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  const payload = results && results[0] ? results[0].result : null;
  if (!payload || !Array.isArray(payload.candidates)) throw new Error('content script returned no candidates');
  payload.scroll = scroll;
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

// One entry point for every trigger: the two right-click menu items and the
// `bulk-download` message. Headless Chrome cannot open a native context menu, so
// the gate drives the message path - keeping them a single function is what makes
// that honest.
//
// Note there is no probing here: a worker has no DOM, so images with no intrinsic
// size stay at 0x0 and a min-size filter will skip them. The popup probes because
// it can (see AGENTS.md).
async function bulkDownload(tabId, scrollOverride) {
  const settings = await loadSettings();
  const scrollConfig = scrollOverride === undefined || scrollOverride === null
    ? settings.scroll
    : mergeScrollOptions({ ...settings.scroll, ...scrollOverride });
  const payload = await scan(tabId, scrollConfig);
  const items = normalizeCandidates(payload.candidates, payload.pageUrl);
  const plan = planDownloads(items, settings);
  const scroll = payload.scroll;
  const result = {
    pageUrl: payload.pageUrl,
    found: items.length,
    planned: plan.length,
    skipped: items.length - plan.length,
    scroll,
    // A run that tripped a safety net did NOT see the whole page. Reporting that as
    // a plain success is the failure mode this feature exists to avoid, so it rides
    // along with the result and shows up on the badge.
    endConfirmed: scroll ? scroll.reachedEnd : null,
    warning: scroll ? scroll.warning : null,
    ids: []
  };
  if (plan.length) {
    const queued = await download(plan);
    result.ids = queued.ids;
  }
  self.__DIAG__.bulkRuns += 1;
  self.__DIAG__.lastBulk = result;
  await setBadge(plan.length, result.endConfirmed === false);
  return result;
}

// The menu is silent by nature - without this the user cannot tell whether the
// click did anything at all. The "?" suffix is the only place an unconfirmed
// scroll is visible to someone who used the menu instead of the popup.
async function setBadge(count, uncertain) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    const base = count > BADGE_CAP ? BADGE_CAP + '+' : String(count);
    const color = uncertain ? '#b45309' : (count > 0 ? '#2d7d46' : '#8a8a8a');
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: uncertain ? base + '?' : base });
  } catch (err) {
    recordError('setBadge', err && err.message ? err.message : String(err));
  }
}

function onMenuClicked(info, tab) {
  if (!info) return;
  const scrolling = info.menuItemId === MENU_ID_SCROLL;
  if (!scrolling && info.menuItemId !== MENU_ID) return;
  self.__DIAG__.menuClicks += 1;
  const tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
  if (tabId === null) {
    recordError('contextMenu', 'click arrived without a tab id');
    return;
  }
  bulkDownload(tabId, scrolling ? { enabled: true } : undefined)
    .catch(err => recordError('contextMenu:bulk', err && err.message ? err.message : String(err)));
}

function createMenuItem(id, title, slot) {
  chrome.contextMenus.create({
    id,
    title,
    contexts: ['page', 'image'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  }, () => {
    const err = chrome.runtime.lastError;
    slot.created = !err;
    slot.error = err ? err.message : null;
    if (err) recordError('contextMenus.create:' + id, err.message);
  });
}

// removeAll first: the worker is restarted constantly and create() on an id that
// already exists fails with "duplicate id", which would leave a working menu next
// to a permanent error in the diagnostics.
function ensureMenu() {
  if (!chrome.contextMenus) {
    self.__DIAG__.contextMenu.error = 'chrome.contextMenus is unavailable - is the permission declared?';
    self.__DIAG__.contextMenuScroll.error = self.__DIAG__.contextMenu.error;
    return;
  }
  try {
    chrome.contextMenus.removeAll(() => {
      createMenuItem(MENU_ID, MENU_TITLE, self.__DIAG__.contextMenu);
      createMenuItem(MENU_ID_SCROLL, MENU_TITLE_SCROLL, self.__DIAG__.contextMenuScroll);
    });
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    self.__DIAG__.contextMenu.error = text;
    self.__DIAG__.contextMenuScroll.error = text;
    recordError('ensureMenu', text);
  }
}

// Listeners must be registered synchronously at the top level or the worker will
// not be woken for the event it is supposed to handle.
if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener(onMenuClicked);
chrome.runtime.onInstalled.addListener(ensureMenu);
ensureMenu();
