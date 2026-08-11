// MV3 service worker: the only place that touches chrome.scripting,
// chrome.downloads and chrome.contextMenus. No decision logic here - that belongs
// in src/core/images.js, src/core/scroll.js and src/core/retry.js.
import { SETTINGS_KEY, mergeSettings, normalizeCandidates, planDownloads } from '../core/images.js';
import { mergeScrollOptions, initScrollRun, observeScroll, scrollSummary } from '../core/scroll.js';
import { mergeRetryOptions, runDownloads } from '../core/retry.js';

const VERSION = '0.4.0';
const CONTENT_SCRIPT = 'src/content/collect.js';
const SCROLL_SCRIPT = 'src/content/scroll_step.js';
const MENU_ID = 'download-all-images';
const MENU_TITLE = 'Download all images on this page';
const MENU_ID_SCROLL = 'download-all-images-scrolled';
const MENU_TITLE_SCROLL = 'Scroll to load more, then download all images';
// Badge text has room for about four characters; past that it is a smear.
const BADGE_CAP = 99;
// The state machine always terminates on its own limits; this only catches a bug
// in the state machine itself, which would otherwise be an infinite loop inside a
// service worker - the worst possible place for one.
const SCROLL_SAFETY_ROUNDS = 10;
// chrome.downloads reports outcomes through onChanged, but a download that already
// finished before the listener attached never fires one. Poll as well; whichever
// answers first wins and neither can invent a terminal state.
const DOWNLOAD_POLL_MS = 250;
const PROGRESS_SNAPSHOT_CAP = 400;

let downloadRunSeq = 0;

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
  downloadRuns: 0,
  lastDownloadRun: null,
  // Every progress payload the worker published, in order. This is what lets the
  // gate assert progress ADVANCED rather than being reported once at the end.
  progressSnapshots: [],
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
  // Added as a sibling, not folded into the field above: `contextMenu` is part of
  // the diagnostic contract and turning it into an array would break every reader.
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
  if (message.type === 'download') return download(message.items, message.retry);
  if (message.type === 'bulk-download') return bulkDownload(message.tabId, message.scroll);
  if (message.type === 'diag') return self.__DIAG__;
  // Progress is broadcast to every extension page; the worker sees its own type
  // come back through nothing, but a popup echo would land here as an unknown type.
  if (message.type === 'download-progress') return null;
  throw new Error('unknown message type: ' + message.type);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drives src/content/scroll_step.js in a loop and feeds every measurement to the
// pure state machine. The worker holds the clock; the criterion, the limits and
// the verdict all live in src/core/scroll.js.
//
// An unconfirmed end is NOT recorded in __DIAG__.errors: it is an expected outcome
// that the caller already surfaces through `warning` and the badge. Filing it as an
// error would make the gate's zero-errors check red for a page doing nothing wrong.
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

// Waits for the REAL end state of one download. "chrome.downloads.download
// resolved" only means an id was handed out - the transfer can still be interrupted
// a moment later, and treating the id as success is how a run silently loses files.
function waitForOutcome(id, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    let poll = null;

    const finish = value => {
      if (settled) return;
      settled = true;
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch { /* nothing useful to do */ }
      clearTimeout(timer);
      clearInterval(poll);
      resolve(value);
    };
    const inspect = item => {
      if (!item || settled) return;
      if (item.state === 'complete') finish({ ok: true, id, filename: item.filename, bytes: item.bytesReceived });
      else if (item.state === 'interrupted') finish({ ok: false, reason: item.error || 'UNKNOWN', id, detail: item.filename || null });
    };
    const look = () => chrome.downloads.search({ id }).then(items => inspect(items && items[0])).catch(() => { /* the worker may be mid-restart */ });
    const onChanged = delta => { if (delta && delta.id === id) look(); };

    chrome.downloads.onChanged.addListener(onChanged);
    poll = setInterval(look, DOWNLOAD_POLL_MS);
    timer = setTimeout(() => finish({ ok: false, reason: 'DOWNLOAD_TIMEOUT', id, detail: `no terminal state within ${timeoutMs}ms` }), timeoutMs);
    look();
  });
}

// The `start` half of the retry driver: everything that touches the browser.
async function startDownload(record, context) {
  let id;
  try {
    id = await chrome.downloads.download({
      url: record.url,
      filename: record.filename,
      // A first attempt must not clobber a file the user already has. A RETRY is a
      // second try at a path we chose ourselves, so it overwrites its own leftovers
      // instead of piling up "name (1).png" copies - which would also quietly break
      // the generated-filename contract.
      conflictAction: context.attempt === 1 ? 'uniquify' : 'overwrite',
      saveAs: false
    });
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    return { ok: false, reason: /invalid|unsupported|scheme/i.test(text) ? 'NETWORK_INVALID_REQUEST' : 'UNKNOWN', detail: text };
  }
  const outcome = await waitForOutcome(id, context.timeoutMs);
  // A download we stopped waiting for must not be left running: it could complete
  // later and turn up in somebody else's count.
  if (!outcome.ok && outcome.reason === 'DOWNLOAD_TIMEOUT') {
    try { await chrome.downloads.cancel(id); } catch { /* already gone */ }
  }
  return outcome;
}

function publishProgress(runId, progress) {
  const snapshot = { runId, ...progress };
  self.__DIAG__.progressSnapshots.push(snapshot);
  if (self.__DIAG__.progressSnapshots.length > PROGRESS_SNAPSHOT_CAP) self.__DIAG__.progressSnapshots.shift();
  setProgressBadge(progress);
  // Nobody may be listening: the popup is closed for every menu-triggered run. That
  // rejection is not an error worth recording - the badge is the other half of this
  // feature for exactly this case.
  try {
    const sent = chrome.runtime.sendMessage({ type: 'download-progress', runId, progress });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch { /* no receiving end */ }
}

// Every download in the extension comes through here - the popup's button and both
// menu items - so the retry policy and the progress reporting cannot grow two
// versions of themselves.
async function download(items, retryOptions) {
  if (!Array.isArray(items) || !items.length) throw new Error('download needs a non-empty item list');
  const config = mergeRetryOptions(retryOptions);
  const runId = ++downloadRunSeq;
  const result = await runDownloads({
    items,
    options: config,
    start: startDownload,
    wait: sleep,
    now: () => Date.now(),
    onProgress: progress => publishProgress(runId, progress)
  });
  self.__DIAG__.downloads += result.done;
  self.__DIAG__.downloadRuns += 1;
  self.__DIAG__.lastDownloadRun = { runId, ...result };
  // A permanent download failure is an OUTCOME, not a crash: it rides out on
  // result.failed, result.warning, the progress bar and the badge. Filing it in
  // __DIAG__.errors would make one dead image on a page turn the gate's
  // zero-uncaught-errors check red - the same reasoning as an unconfirmed scroll.
  await setBadge(result.done, false, result.failed + result.skipped, result.total);
  return { runId, ...result };
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored ? stored[SETTINGS_KEY] : null);
}

// One entry point for every trigger: both right-click menu items and the
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
    ids: [],
    // Download outcomes are namespaced: `skipped` above already means "filtered out
    // before we ever tried", and one word cannot mean two things in one report.
    downloaded: 0,
    failed: 0,
    retries: 0,
    downloadWarning: null,
    failures: []
  };
  if (plan.length) {
    const run = await download(plan);
    result.ids = run.ids;
    result.downloaded = run.done;
    result.failed = run.failed + run.skipped;
    result.retries = run.retries;
    result.downloadWarning = run.warning;
    result.failures = run.failures;
    result.download = {
      total: run.total, done: run.done, failed: run.failed, skipped: run.skipped,
      retries: run.retries, attempts: run.attempts, elapsedMs: run.elapsedMs, bytes: run.bytes
    };
  }
  self.__DIAG__.bulkRuns += 1;
  self.__DIAG__.lastBulk = result;
  await setBadge(result.downloaded, result.endConfirmed === false, result.failed, plan.length);
  return result;
}

// Four characters of room, so a long ratio degrades to a percentage rather than a
// smear.
function ratioText(done, total) {
  const text = `${done}/${total}`;
  if (text.length <= 4) return text;
  return `${total > 0 ? Math.floor((done * 100) / total) : 0}%`;
}

function setProgressBadge(progress) {
  if (!chrome.action || !chrome.action.setBadgeText || progress.complete) return;
  chrome.action.setBadgeBackgroundColor({ color: '#1d4ed8' }).catch(() => {});
  chrome.action.setBadgeText({ text: ratioText(progress.settled, progress.total) }).catch(() => {});
}

// The menu is silent by nature - without this the user cannot tell whether the
// click did anything at all. The trailing "?" is the only place an unconfirmed
// scroll is visible to someone who used the menu instead of the popup, and a
// "2/3" is the only place a failed download is.
async function setBadge(done, uncertain, failed = 0, total = done) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    const base = failed > 0
      ? ratioText(done, total)
      : (done > BADGE_CAP ? BADGE_CAP + '+' : String(done));
    let color = failed > 0 ? '#b91c1c' : (done > 0 ? '#2d7d46' : '#8a8a8a');
    if (uncertain) color = '#b45309';
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
