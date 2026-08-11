// MV3 service worker: the only place that touches chrome.scripting and
// chrome.downloads. No decision logic here - that belongs in src/core/images.js.
const VERSION = '0.1.0';
const CONTENT_SCRIPT = 'src/content/collect.js';

// Read-only diagnostic surface for the verification gate.
// Fields may be ADDED, never renamed or removed (see AGENTS.md).
self.__DIAG__ = { version: VERSION, scans: 0, downloads: 0, errors: [] };

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
