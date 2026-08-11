#!/usr/bin/env node
// Browser gate: loads the unpacked extension in headless Chrome and asserts real
// behaviour, not the existence of code. Slower than the fast gate, so CI runs the
// two in parallel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { Report } from './lib/report.js';
import { decodePng, countDistinctColors } from './lib/png.js';
import { startServer } from '../test/fixtures/server.js';
import { EXPECTED } from '../test/fixtures/expected.js';
import { DEFAULT_RETRY_OPTIONS } from '../src/core/retry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
// Coupled with PROBE_TIMEOUT_MS (4000) in src/popup/popup.js: polling has to outlast
// the worst-case image probe or every scan assertion becomes a flaky timeout.
// Change one, recheck the other (AGENTS.md).
const POLL_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;
// Lives in expected.js so the FAST gate can check it against worstCaseItemMs() from
// the retry defaults: one file that keeps failing must FAIL this gate, never time it
// out. Change the retry budgets and the fast gate will tell you if this needs to
// move with them.
const DOWNLOAD_TIMEOUT_MS = EXPECTED.downloads.gateTimeoutMs;
const LAUNCH_TIMEOUT_MS = 60000;

// Auto-scroll option sets. Coupled to the fixture batch maths in expected.js:
// scroll-finite.html needs 3 scrolls to load its batches plus 3 more to confirm the
// end, so maxScrolls has to stay comfortably above 6 here or the finite page would
// fail for hitting a cap this test never meant to exercise.
// settleMs 500 vs the fixtures' 120ms load delay keeps ~4x margin on a slow runner.
const GATE_SCROLL = { enabled: true, stableRounds: 3, maxScrolls: 12, timeoutMs: 45000, settleMs: 500, maxImages: 0 };
const ENDLESS_SCROLL = { ...GATE_SCROLL, maxScrolls: 6 };
const TIMEOUT_SCROLL = { enabled: true, stableRounds: 3, maxScrolls: 200, timeoutMs: 1500, settleMs: 200, maxImages: 0 };
const CAP_SCROLL = { ...GATE_SCROLL, maxScrolls: 20, maxImages: EXPECTED.scroll.imageCap };

const report = new Report('browser gate');
const ctx = { errors: [], screenshots: {}, lastDiag: null, navigations: 0 };

fs.mkdirSync(ARTIFACTS, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Predicates MUST return a real boolean. Returning a count means 0 reads as 'not
// ready yet' and the failure surfaces as a timeout instead of a wrong value.
async function waitFor(label, predicate, { timeout = POLL_TIMEOUT_MS, snapshot = null } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    let value = false;
    try {
      value = await predicate();
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      value = false;
    }
    if (value === true) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  let evidence = lastError ? `last predicate error: ${lastError}` : '';
  if (snapshot) {
    try { evidence += '\n' + JSON.stringify(await snapshot(), null, 2); }
    catch (err) { evidence += `\n(snapshot failed: ${err.message})`; }
  }
  const error = new Error(`timed out after ${timeout}ms waiting for ${label}`);
  error.evidence = evidence;
  throw error;
}

function evidenceError(message, evidence) {
  const error = new Error(message);
  error.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  return error;
}

function expect(actual, expected, what) {
  if (actual !== expected) throw evidenceError(`${what}: expected ${expected}, got ${actual}`, ctx.lastDiag);
}

function watch(page, label) {
  page.on('pageerror', err => ctx.errors.push(`${label} pageerror: ${err && err.message ? err.message : err}`));
  page.on('console', msg => { if (msg.type() === 'error') ctx.errors.push(`${label} console.error: ${msg.text()}`); });
}

function stageExtension() {
  // Load only what ships. Pointing Chrome at the repo root would also hand it
  // node_modules and the test tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-grabber-ext-'));
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  return dir;
}

// The MV3 service worker can be shut down between steps; re-acquire it on failure.
async function swEval(fn, ...args) {
  try {
    return await ctx.worker.evaluate(fn, ...args);
  } catch (err) {
    const target = await ctx.browser.waitForTarget(
      t => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${ctx.extId}`),
      { timeout: 15000 }
    );
    ctx.worker = await target.worker();
    return ctx.worker.evaluate(fn, ...args);
  }
}

const diag = (page = ctx.popup) => page.evaluate(() => (window.__DIAG__ ? window.__DIAG__.state : null));

async function resolveTabId(url) {
  return swEval(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find(t => t.url === u);
    return hit ? hit.id : -1;
  }, url);
}

// Two things matter here and both cost a red run to learn:
//
// 1. Every load gets a fresh ?run= so the browser cannot restore the previous
//    scroll position. A scroll test that starts half way down passes for the wrong
//    reason.
// 2. The tab has to be in the FOREGROUND. Chrome throttles timers in hidden tabs,
//    and the fixtures load their next batch on a setTimeout - in a background tab
//    that batch never arrives, the page sits at its initial images and the run
//    settles, honestly reporting a bottom that only exists because the page was
//    asleep. A real user always scrolls the tab they are looking at, so this is the
//    accurate simulation rather than a workaround.
async function loadFixture(tab) {
  ctx.navigations += 1;
  tab.url = `${ctx.server.origin}/${tab.name}?run=${ctx.navigations}`;
  await tab.page.bringToFront();
  await tab.page.goto(tab.url, { waitUntil: 'networkidle2', timeout: 30000 });
  tab.tabId = await resolveTabId(tab.url);
  if (tab.tabId < 0) throw evidenceError(`the extension could not find the tab for ${tab.name}`, tab.url);
  return tab;
}

async function openFixtureTab(name, label) {
  const page = await ctx.browser.newPage();
  watch(page, label);
  return loadFixture({ name, label, page, url: null, tabId: -1 });
}

// Evidence for any scroll failure. The summary alone cannot say whether the page was
// even able to scroll, which is the first thing you want to know when a lazy page
// did not grow.
async function scrollEvidence(tab, summary) {
  let page;
  try {
    page = await tab.page.evaluate(() => ({
      fixture: window.__FIXTURE__ || null,
      images: document.images.length,
      scrollY: Math.round(window.scrollY),
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      hidden: document.hidden
    }));
  } catch (err) {
    page = { readFailed: err && err.message ? err.message : String(err) };
  }
  return { url: tab.url, summary, page };
}

async function scanWith(tabId, scroll) {
  const response = await ctx.popup.evaluate(
    (id, options) => chrome.runtime.sendMessage({ type: 'scan', tabId: id, scroll: options }),
    tabId,
    scroll || null
  );
  if (!response || !response.ok) throw evidenceError('the scan request failed', response);
  return response.data;
}

async function bulkWith(tabId, scroll) {
  const response = await ctx.popup.evaluate(
    (id, options) => chrome.runtime.sendMessage({ type: 'bulk-download', tabId: id, scroll: options }),
    tabId,
    scroll || null
  );
  if (!response || !response.ok) throw evidenceError('the bulk download request failed', response);
  return response.data;
}

// The popup's own download path, with the item list handed in directly. Retry checks
// go through here rather than through a page because a page whose <img> answers 500
// logs a console error, and the zero-errors check would then fail for a reason that
// has nothing to do with retrying. The menu path gets its failure covered by
// downloads.html and /once/ instead.
async function downloadWith(items) {
  const response = await ctx.popup.evaluate(
    list => chrome.runtime.sendMessage({ type: 'download', items: list }),
    items
  );
  if (!response || !response.ok) throw evidenceError('the download request failed', response);
  return response.data;
}

async function openPopup(tabId) {
  const target = tabId === undefined ? ctx.tabId : tabId;
  await ctx.popup.goto(`chrome-extension://${ctx.extId}/src/popup/popup.html?tabId=${target}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await waitFor('popup phase to reach ready', async () => {
    const state = await diag();
    ctx.lastDiag = state;
    return state !== null && state.phase === 'ready';
  }, { snapshot: () => diag() });
}

async function setNumber(id, value) {
  await ctx.popup.evaluate((elementId, v) => {
    const el = document.getElementById(elementId);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, value);
}

async function waitForVisible(count) {
  await waitFor(`visible item count to be ${count}`, async () => {
    const state = await diag();
    ctx.lastDiag = state;
    return state !== null && state.visible === count;
  }, { snapshot: () => diag() });
}

async function shoot(name) {
  const file = path.join(ARTIFACTS, name);
  const buffer = await ctx.popup.screenshot({ path: file });
  ctx.screenshots[name] = file;
  return Buffer.from(buffer);
}

function describeDownloads(items) {
  return (items || []).map(i => ({ id: i.id, filename: i.filename, state: i.state, bytes: i.bytesReceived, error: i.error }));
}

// Shared by the bulk-download checks: complete downloads that are not on disk are
// the whole reason this gate looks at the filesystem instead of trusting the API.
async function expectFilesOnDisk(ids, expectedCount, label) {
  const mine = (ctx.downloads || []).filter(i => ids.includes(i.id) && i.state === 'complete');
  if (mine.length !== expectedCount) {
    throw evidenceError(`${mine.length} of ${expectedCount} ${label} downloads completed`, describeDownloads((ctx.downloads || []).filter(i => ids.includes(i.id))));
  }
  const onDisk = mine.filter(i => i.filename && fs.existsSync(i.filename) && fs.statSync(i.filename).size > 0);
  if (onDisk.length !== mine.length) {
    throw evidenceError('chrome reported complete downloads that are not on disk', describeDownloads(mine));
  }
  const folders = new Set(onDisk.map(i => path.basename(path.dirname(i.filename))));
  if (folders.size !== 1 || !folders.has('image-grabber')) {
    throw evidenceError(`${label} downloads did not all land in the image-grabber folder`, onDisk.map(i => i.filename).join('\n'));
  }
  const bytes = onDisk.reduce((sum, i) => sum + fs.statSync(i.filename).size, 0);
  return { count: onDisk.length, bytes };
}

// Progress snapshots the worker published for one run, in order.
async function progressFor(runId) {
  return swEval(id => self.__DIAG__.progressSnapshots.filter(s => s.runId === id), runId);
}

const steps = [
  {
    title: 'unpacked extension loads and its service worker is alive',
    critical: true,
    run: async () => {
      ctx.extDir = stageExtension();
      ctx.server = await startServer();
      // No CDP Browser.setDownloadBehavior here: pointing it at a download path makes
      // Chrome auto-name files from the URL, which silently throws away the filename
      // chrome.downloads was given. We read the path Chrome reports back instead.
      ctx.browser = await puppeteer.launch({
        headless: true,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          // CI containers have no GPU. Force ANGLE + SwiftShader so anything that
          // touches a graphics context degrades to software instead of failing.
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          `--disable-extensions-except=${ctx.extDir}`,
          `--load-extension=${ctx.extDir}`
        ]
      });
      const target = await ctx.browser.waitForTarget(
        t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
        { timeout: 30000 }
      );
      ctx.extId = new URL(target.url()).host;
      ctx.worker = await target.worker();
      const info = await swEval(() => ({
        name: chrome.runtime.getManifest().name,
        version: chrome.runtime.getManifest().version,
        diag: typeof self.__DIAG__
      }));
      if (info.diag !== 'object') throw new Error('service worker exposes no __DIAG__ object');
      return `${info.name} v${info.version} loaded as ${ctx.extId}, fixtures on ${ctx.server.origin}`;
    }
  },
  {
    title: 'fixture page serves and its tab is addressable from the extension',
    critical: true,
    run: async () => {
      ctx.pageUrl = ctx.server.origin + '/gallery.html';
      ctx.page = await ctx.browser.newPage();
      watch(ctx.page, 'fixture page');
      const res = await ctx.page.goto(ctx.pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      if (!res || !res.ok()) throw new Error(`fixture page returned ${res ? res.status() : 'no response'}`);
      const imgCount = await ctx.page.evaluate(() => document.images.length);
      if (imgCount !== EXPECTED.imgElements) throw new Error(`fixture has ${imgCount} <img> elements, expected ${EXPECTED.imgElements}`);
      ctx.tabId = await resolveTabId(ctx.pageUrl);
      if (ctx.tabId < 0) throw new Error('the extension could not find the fixture tab');
      return `tab ${ctx.tabId} serving ${imgCount} img elements`;
    }
  },
  {
    title: 'popup opens, injects the content script and reaches the ready phase',
    critical: true,
    run: async () => {
      ctx.popup = await ctx.browser.newPage();
      watch(ctx.popup, 'popup');
      await ctx.popup.setViewport({ width: 440, height: 720 });
      await openPopup();
      const state = await diag();
      ctx.lastDiag = state;
      return `ready: ${state.scanned} unique images from ${state.rawCandidates} raw candidates`;
    }
  },
  {
    title: 'scan collects every candidate and dedupes them to unique images',
    run: async () => {
      const state = await diag();
      ctx.lastDiag = state;
      expect(state.rawCandidates, EXPECTED.rawCandidates, 'raw candidates');
      expect(state.scanned, EXPECTED.uniqueImages, 'unique images after dedupe');
      const dup = state.items.find(i => i.url.endsWith('/img/400x300.png'));
      if (!dup) throw evidenceError('the thrice-referenced image is missing from the scan', state);
      expect(dup.occurrences, 3, 'occurrences of img/400x300.png');
      expect(dup.width, 400, 'width kept after dedupe');
      expect(dup.height, 300, 'height kept after dedupe');
      return `${state.rawCandidates} raw -> ${state.scanned} unique; duplicate merged (3 occurrences, 400x300 kept)`;
    }
  },
  {
    title: 'background images with no intrinsic size get probed to real dimensions',
    run: async () => {
      const state = await diag();
      ctx.lastDiag = state;
      const bg = state.items.find(i => i.url.endsWith(EXPECTED.probedBackground.path));
      if (!bg) throw evidenceError('the background image never made it into the scan', state);
      expect(bg.width, EXPECTED.probedBackground.width, 'probed width');
      expect(bg.height, EXPECTED.probedBackground.height, 'probed height');
      return `${EXPECTED.probedBackground.path} probed to ${bg.width}x${bg.height} (${state.probed} probes run)`;
    }
  },
  {
    title: 'data: URLs are scanned but hidden by default',
    run: async () => {
      const state = await diag();
      ctx.lastDiag = state;
      if (!state.items.some(i => i.url.startsWith('data:'))) throw evidenceError('the inline data: image was never scanned', state);
      expect(state.visible, EXPECTED.defaultVisible, 'visible items with default settings');
      expect(state.renderedRows, EXPECTED.defaultVisible, 'rendered rows');
      return `${state.scanned} scanned, ${state.visible} shown, inline data URL withheld`;
    }
  },
  {
    title: 'min-width filter narrows the rendered list',
    run: async () => {
      await setNumber('minWidth', 200);
      await waitForVisible(EXPECTED.minWidth200Visible);
      const state = await diag();
      ctx.lastDiag = state;
      expect(state.renderedRows, EXPECTED.minWidth200Visible, 'rendered rows');
      return `minWidth=200 leaves ${state.visible} of ${state.scanned}`;
    }
  },
  {
    title: 'an impossible filter renders the empty state',
    critical: true,
    run: async () => {
      await setNumber('minWidth', 99999);
      await waitForVisible(0);
      const shown = await ctx.popup.evaluate(() => !document.getElementById('empty').hidden);
      if (!shown) throw new Error('list is empty but the empty-state message is hidden');
      // This screenshot is the baseline for the colour delta in the next step. Note
      // how high the number is: that is exactly why an absolute floor there was
      // meaningless.
      ctx.colorsEmpty = countDistinctColors(decodePng(await shoot('popup-empty.png')), 3);
      return `0 rows, empty state shown, ${ctx.colorsEmpty} distinct colours on screen`;
    }
  },
  {
    title: 'the populated list actually paints pixels (colour delta vs the empty state)',
    run: async () => {
      await setNumber('minWidth', 0);
      await waitForVisible(EXPECTED.defaultVisible);
      await waitFor('thumbnails to decode', async () => ctx.popup.evaluate(
        () => Array.from(document.querySelectorAll('img.thumb')).every(i => i.complete && i.naturalWidth > 0)
      ));
      ctx.colorsPopulated = countDistinctColors(decodePng(await shoot('popup-populated.png')), 3);
      // Only the delta is asserted. An absolute floor (minColorsPopulated = 40) used
      // to sit here and it could never fail: the EMPTY popup already samples ~395
      // colours of chrome and text, so it passed with the list completely broken.
      // The difference between the two screenshots is the part that can only come
      // from decoded thumbnails.
      if (!(ctx.colorsEmpty > 0)) {
        throw evidenceError('no empty-state baseline was captured, so a delta would prove nothing', { empty: ctx.colorsEmpty, populated: ctx.colorsPopulated });
      }
      const delta = ctx.colorsPopulated - ctx.colorsEmpty;
      if (delta < EXPECTED.minColorDelta) {
        throw evidenceError(`colour delta is ${delta}, expected at least ${EXPECTED.minColorDelta}`, { empty: ctx.colorsEmpty, populated: ctx.colorsPopulated, delta, floor: EXPECTED.minColorDelta });
      }
      return `${ctx.colorsEmpty} -> ${ctx.colorsPopulated} distinct colours (delta ${delta}, floor ${EXPECTED.minColorDelta})`;
    }
  },
  {
    title: 'format filter removes the jpg-classified image',
    critical: true,
    run: async () => {
      await setNumber('minWidth', 200);
      await waitForVisible(EXPECTED.minWidth200Visible);
      await ctx.popup.click('#fmt-jpg');
      await waitForVisible(EXPECTED.minWidth200NoJpgVisible);
      const state = await diag();
      ctx.lastDiag = state;
      if (state.settings.formats.includes('jpg')) throw evidenceError('jpg is still enabled in settings after unchecking it', state.settings);
      expect(state.scanned, EXPECTED.uniqueImages, 'scan result must not change when filtering');
      return `unchecking jpg: ${EXPECTED.minWidth200Visible} -> ${state.visible} visible, scan untouched`;
    }
  },
  {
    title: 'download writes real files to disk through chrome.downloads',
    run: async () => {
      const before = await swEval(() => chrome.downloads.search({}).then(items => items.length));
      const state = await diag();
      ctx.lastDiag = state;
      expect(state.selected, EXPECTED.downloadCount, 'selected items before download');
      await ctx.popup.click('#download');
      await waitFor('downloads to reach state=complete', async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + EXPECTED.downloadCount;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => ctx.downloads });
      const done = (ctx.downloads || []).filter(i => i.state === 'complete');
      const paths = done.map(i => i.filename);
      const onDisk = done.filter(i => i.filename && fs.existsSync(i.filename) && fs.statSync(i.filename).size > 0);
      if (onDisk.length !== done.length) {
        throw evidenceError('chrome reported complete downloads that are not on disk', done.map(i => ({ filename: i.filename, state: i.state, bytes: i.bytesReceived })));
      }
      const names = onDisk.map(i => path.basename(i.filename));
      if (!names.some(n => n.startsWith('img-001-400x300'))) {
        throw evidenceError('the generated filename was not used - expected img-001-400x300.png among the downloads', paths.join('\n'));
      }
      const folders = onDisk.map(i => path.basename(path.dirname(i.filename)));
      if (!folders.every(f => f === 'image-grabber')) throw evidenceError('downloads did not land in the image-grabber folder', paths.join('\n'));
      return `${onDisk.length} files written: ${onDisk.map(i => `${path.basename(i.filename)} (${fs.statSync(i.filename).size}B)`).join(', ')}`;
    }
  },
  {
    title: 'settings survive a popup reload',
    run: async () => {
      await openPopup();
      const state = await diag();
      ctx.lastDiag = state;
      expect(state.settings.minWidth, 200, 'persisted minWidth');
      if (state.settings.formats.includes('jpg')) throw evidenceError('the jpg filter did not persist across a reload', state.settings);
      await waitForVisible(EXPECTED.minWidth200NoJpgVisible);
      return `after reload: minWidth=${state.settings.minWidth}, formats=${state.settings.formats.join('/')}`;
    }
  },
  {
    title: 'a second tab scans independently',
    run: async () => {
      const url = ctx.server.origin + '/gallery2.html';
      const page = await ctx.browser.newPage();
      watch(page, 'second fixture page');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const tabId = await resolveTabId(url);
      if (tabId < 0) throw new Error('could not resolve the second tab');
      await openPopup(tabId);
      const state = await diag();
      ctx.lastDiag = state;
      expect(state.scanned, EXPECTED.secondPageUnique, 'unique images on the second page');
      if (state.pageUrl !== url) throw evidenceError(`popup scanned ${state.pageUrl}, expected ${url}`, state);
      return `second tab scanned on its own: ${state.scanned} images from ${state.pageUrl}`;
    }
  },
  {
    title: 'the page context menu is registered with chrome and its click handler is attached',
    critical: true,
    run: async () => {
      const api = await swEval(() => typeof chrome.contextMenus);
      if (api !== 'object') throw evidenceError(`chrome.contextMenus is ${api} in the worker - is the permission declared?`, { api });
      // Registration is asynchronous (removeAll -> create), so poll for a verdict
      // instead of racing it. Either outcome ends the wait; the assertions below
      // decide which one it was.
      await waitFor('the context menu registration to report back', async () => {
        ctx.menu = await swEval(() => {
          const m = self.__DIAG__.contextMenu;
          return m ? { id: m.id, created: m.created, error: m.error, listenerAttached: m.listenerAttached } : null;
        });
        return Boolean(ctx.menu && (ctx.menu.created || ctx.menu.error));
      }, { snapshot: () => ctx.menu });
      if (ctx.menu.error) throw evidenceError('chrome rejected the context menu: ' + ctx.menu.error, ctx.menu);
      if (!ctx.menu.created) throw evidenceError('the context menu was never created', ctx.menu);
      if (ctx.menu.id !== EXPECTED.contextMenuId) throw evidenceError(`menu id is ${ctx.menu.id}, expected ${EXPECTED.contextMenuId}`, ctx.menu);
      // A menu item nobody listens to looks perfectly healthy and does nothing.
      if (!ctx.menu.listenerAttached) throw evidenceError('nothing is listening on contextMenus.onClicked - the item would be inert', ctx.menu);
      return `menu ${ctx.menu.id} accepted by chrome, onClicked handler attached`;
    }
  },
  {
    title: 'the context-menu action bulk-downloads every filtered image to disk',
    run: async () => {
      // Headless Chrome cannot open a native context menu, so the gate drives the
      // other trigger of the SAME function (bulkDownload in the service worker) and
      // the step above proves the click is wired to it.
      //
      // Earlier steps left minWidth=200 with jpg off. This path has no UI of its own
      // - it reads the stored settings - so reset them and expect the whole page.
      await swEval(() => chrome.storage.local.remove('settings'));
      const before = await swEval(() => chrome.downloads.search({}).then(items => items.length));
      const data = await bulkWith(ctx.tabId, null);
      ctx.lastDiag = data;
      expect(data.found, EXPECTED.uniqueImages, 'images found by the menu-triggered scan');
      expect(data.planned, EXPECTED.bulkDownloads, 'images queued in one click');
      expect(data.skipped, EXPECTED.bulkSkipped, 'images skipped by the stored filters');
      expect(data.downloaded, EXPECTED.bulkDownloads, 'images that reached disk');
      expect(data.failed, 0, 'failed downloads on a healthy page');
      // No scrolling was asked for, so there is no end to confirm either way.
      if (data.scroll !== null) throw evidenceError('a bulk run without auto-scroll reported a scroll summary', data.scroll);

      await waitFor(`${EXPECTED.bulkDownloads} menu-triggered downloads to complete`, async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + EXPECTED.bulkDownloads;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });

      const written = await expectFilesOnDisk(data.ids, EXPECTED.bulkDownloads, 'menu');
      const names = (ctx.downloads || []).filter(i => data.ids.includes(i.id)).map(i => path.basename(i.filename || ''));
      const stray = names.find(n => !/^img-\d{3}-/.test(n));
      if (stray) throw evidenceError(`${stray} is not a generated name - chrome named this one itself`, names.join('\n'));
      if (names.some(n => n.includes('inline'))) throw evidenceError('the inline data: url was downloaded despite being filtered out', names.join('\n'));

      const badge = await swEval(() => chrome.action.getBadgeText({}));
      if (badge !== String(EXPECTED.bulkDownloads)) {
        throw evidenceError(`the toolbar badge reads ${badge}, expected ${EXPECTED.bulkDownloads} - the only feedback this action gives`, { badge });
      }
      const bulk = await swEval(() => ({ runs: self.__DIAG__.bulkRuns, last: self.__DIAG__.lastBulk }));
      if (!bulk.last || bulk.runs < 1) throw evidenceError('the worker recorded no bulk run', bulk);
      expect(bulk.last.planned, EXPECTED.bulkDownloads, 'DIAG.lastBulk.planned');

      return `one action -> ${written.count} files, ${written.bytes}B total: ${names.join(', ')}; badge ${badge}`;
    }
  },
  {
    title: 'auto-scroll pulls in images that a plain scan never sees',
    critical: true,
    run: async () => {
      ctx.finite = await openFixtureTab('scroll-finite.html', 'finite lazy fixture');
      const plain = await scanWith(ctx.finite.tabId, null);
      if (plain.scroll !== null) throw evidenceError('a scan with scrolling disabled still reported a scroll run', plain.scroll);
      expect(plain.candidates.length, EXPECTED.scroll.finiteInitialImages, 'images reachable without scrolling');

      const scrolled = await scanWith(ctx.finite.tabId, GATE_SCROLL);
      const summary = scrolled.scroll;
      if (!summary) throw evidenceError('scrolling was requested but no scroll summary came back', scrolled);
      ctx.lastDiag = await scrollEvidence(ctx.finite, summary);
      expect(scrolled.candidates.length, EXPECTED.scroll.finiteTotalImages, 'images after auto-scroll');
      expect(summary.outcome, 'settled', 'scroll outcome on a page that ends');
      expect(summary.reachedEnd, true, 'reachedEnd');
      expect(summary.stableRounds, GATE_SCROLL.stableRounds, 'consecutive unchanged rounds at the verdict');
      expect(summary.growthRounds, EXPECTED.scroll.finiteGrowthRounds, 'rounds in which new images arrived');
      if (summary.warning !== null) throw evidenceError('a confirmed end still carried a warning', summary);
      // The one comparison that can only hold if the feature does something.
      if (scrolled.candidates.length <= plain.candidates.length) {
        throw evidenceError('auto-scroll found no more images than a plain scan', ctx.lastDiag);
      }
      return `${plain.candidates.length} -> ${scrolled.candidates.length} images in ${summary.scrolls} scrolls, settled after ${summary.stableRounds} unchanged rounds`;
    }
  },
  {
    title: 'a page that never ends stops at the scroll cap and reports the end as not confirmed',
    run: async () => {
      ctx.endless = await openFixtureTab('scroll-endless.html', 'endless lazy fixture');
      const data = await scanWith(ctx.endless.tabId, ENDLESS_SCROLL);
      const summary = data.scroll;
      ctx.lastDiag = await scrollEvidence(ctx.endless, summary);
      expect(summary.outcome, 'max-scrolls', 'scroll outcome on a page with no bottom');
      expect(summary.reachedEnd, false, 'reachedEnd');
      expect(summary.scrolls, ENDLESS_SCROLL.maxScrolls, 'scrolls performed before giving up');
      if (!summary.warning || !/NOT confirmed/.test(summary.warning)) {
        throw evidenceError('a run that gave up came back without a warning saying so', ctx.lastDiag);
      }
      // Giving up is not the same as returning nothing: it still hands back what it
      // did see.
      if (data.candidates.length < EXPECTED.scroll.endlessMinImages) {
        throw evidenceError(`only ${data.candidates.length} images collected before the cap, expected at least ${EXPECTED.scroll.endlessMinImages}`, ctx.lastDiag);
      }
      return `gave up after ${summary.scrolls} scrolls with ${data.candidates.length} images - ${summary.warning}`;
    }
  },
  {
    title: 'the total timeout also ends an endless page as not confirmed, and ends it promptly',
    run: async () => {
      await loadFixture(ctx.endless);
      const data = await scanWith(ctx.endless.tabId, TIMEOUT_SCROLL);
      const summary = data.scroll;
      ctx.lastDiag = await scrollEvidence(ctx.endless, summary);
      expect(summary.outcome, 'timeout', 'scroll outcome when the clock runs out first');
      expect(summary.reachedEnd, false, 'reachedEnd');
      // A page that never grew would settle long before this deadline, so timing out
      // only means something if the page was genuinely still feeding us.
      if (summary.growthRounds < 1) {
        throw evidenceError('the page produced no new images at all, so the timeout proves nothing here', ctx.lastDiag);
      }
      if (summary.elapsedMs < TIMEOUT_SCROLL.timeoutMs) {
        throw evidenceError(`the timeout fired at ${summary.elapsedMs}ms, before its own ${TIMEOUT_SCROLL.timeoutMs}ms deadline`, ctx.lastDiag);
      }
      // Only here to catch a timeout that never actually stops anything. The ceiling
      // keeps ~10x margin over the deadline; it is not a performance budget.
      if (summary.elapsedMs > EXPECTED.scroll.timeoutCeilingMs) {
        throw evidenceError(`the run kept going for ${summary.elapsedMs}ms, long past its ${TIMEOUT_SCROLL.timeoutMs}ms timeout`, ctx.lastDiag);
      }
      return `stopped at ${summary.elapsedMs}ms (deadline ${TIMEOUT_SCROLL.timeoutMs}ms) after ${summary.scrolls} scrolls, end not confirmed`;
    }
  },
  {
    title: 'a page whose loader dies half-way returns exactly the images that arrived',
    run: async () => {
      ctx.broken = await openFixtureTab('scroll-broken.html', 'half-broken lazy fixture');
      const data = await scanWith(ctx.broken.tabId, GATE_SCROLL);
      const summary = data.scroll;
      ctx.lastDiag = await scrollEvidence(ctx.broken, summary);
      // Without this the check is meaningless: a fixture that quietly finished on its
      // own would produce identical numbers and prove nothing about a failure.
      const fixture = await ctx.broken.page.evaluate(() => window.__FIXTURE__);
      if (fixture.failed !== true || fixture.batches !== 1) {
        throw evidenceError('the fixture never actually failed, so this check proves nothing', ctx.lastDiag);
      }
      expect(data.candidates.length, EXPECTED.scroll.brokenTotalImages, 'images collected from a page that broke');
      expect(summary.growthRounds, EXPECTED.scroll.brokenGrowthRounds, 'rounds in which new images arrived');
      // Documented blind spot: a page that stops growing is indistinguishable from a
      // page that has ended, so this reports a confirmed end. See AGENTS.md.
      expect(summary.outcome, 'settled', 'scroll outcome on a page that broke and then stopped changing');
      expect(summary.reachedEnd, true, 'reachedEnd');
      return `loader died after ${fixture.batches} batch: ${data.candidates.length} images, ${summary.growthRounds} growth round, settled in ${summary.scrolls} scrolls`;
    }
  },
  {
    title: 'the optional image cap ends a run through the normal path, not the safety net',
    run: async () => {
      await loadFixture(ctx.endless);
      const data = await scanWith(ctx.endless.tabId, CAP_SCROLL);
      const summary = data.scroll;
      ctx.lastDiag = await scrollEvidence(ctx.endless, summary);
      expect(summary.outcome, 'image-cap', 'scroll outcome when the cap is reached');
      expect(summary.reachedEnd, true, 'reachedEnd');
      if (summary.warning !== null) throw evidenceError('stopping at the requested count is not a failure and must not warn', ctx.lastDiag);
      if (summary.imagesAtEnd < EXPECTED.scroll.imageCap) {
        throw evidenceError(`stopped at ${summary.imagesAtEnd} images, below the ${EXPECTED.scroll.imageCap} that were asked for`, ctx.lastDiag);
      }
      // If it had run all the way to the scroll cap as well, the outcome above would
      // be a coincidence rather than proof the image cap did anything.
      if (summary.scrolls >= CAP_SCROLL.maxScrolls) {
        throw evidenceError('the run reached the scroll cap too, so the image cap proves nothing here', ctx.lastDiag);
      }
      return `stopped at ${summary.imagesAtEnd} images after ${summary.scrolls} scrolls (cap ${EXPECTED.scroll.imageCap}, scroll cap ${CAP_SCROLL.maxScrolls} untouched)`;
    }
  },
  {
    title: 'the scrolling menu item is wired and its bulk run downloads the whole lazy page',
    run: async () => {
      const menu = await swEval(() => {
        const m = self.__DIAG__.contextMenuScroll;
        return m ? { id: m.id, created: m.created, error: m.error, listenerAttached: m.listenerAttached } : null;
      });
      if (!menu) throw new Error('the worker exposes no diagnostics for the scrolling menu item');
      if (menu.error) throw evidenceError('chrome rejected the scrolling menu item: ' + menu.error, menu);
      if (!menu.created) throw evidenceError('the scrolling menu item was never created', menu);
      if (menu.id !== EXPECTED.contextMenuScrollId) throw evidenceError(`scrolling menu id is ${menu.id}, expected ${EXPECTED.contextMenuScrollId}`, menu);
      if (!menu.listenerAttached) throw evidenceError('nothing is listening for clicks on the scrolling menu item', menu);

      await swEval(() => chrome.storage.local.remove('settings'));
      await loadFixture(ctx.finite);
      const before = await swEval(() => chrome.downloads.search({}).then(items => items.length));
      const data = await bulkWith(ctx.finite.tabId, GATE_SCROLL);
      ctx.lastDiag = await scrollEvidence(ctx.finite, data);
      expect(data.found, EXPECTED.scroll.finiteTotalImages, 'images found by the scrolling bulk run');
      expect(data.planned, EXPECTED.scroll.finiteTotalImages, 'images queued');
      expect(data.endConfirmed, true, 'endConfirmed');

      await waitFor(`${data.planned} scrolled bulk downloads to complete`, async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + data.planned;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });

      const written = await expectFilesOnDisk(data.ids, data.planned, 'scrolled bulk');
      const badge = await swEval(() => chrome.action.getBadgeText({}));
      if (badge !== String(data.planned)) {
        throw evidenceError(`the badge reads ${badge}, expected ${data.planned} with no uncertainty marker`, { badge, planned: data.planned });
      }
      return `menu ${menu.id} wired; one action -> ${written.count} files (${written.bytes}B) after ${data.scroll.scrolls} scrolls, badge ${badge}`;
    }
  },
  {
    title: 'a bulk run that never confirmed the end marks itself instead of passing for a clean sweep',
    run: async () => {
      await swEval(() => chrome.storage.local.remove('settings'));
      await loadFixture(ctx.endless);
      const before = await swEval(() => chrome.downloads.search({}).then(items => items.length));
      const data = await bulkWith(ctx.endless.tabId, ENDLESS_SCROLL);
      ctx.lastDiag = await scrollEvidence(ctx.endless, data);
      expect(data.endConfirmed, false, 'endConfirmed on a page with no bottom');
      if (!data.warning || !/NOT confirmed/.test(data.warning)) {
        throw evidenceError('the bulk result carried no warning about the unconfirmed end', ctx.lastDiag);
      }
      if (data.planned < EXPECTED.scroll.endlessMinImages) {
        throw evidenceError(`only ${data.planned} images queued, expected at least ${EXPECTED.scroll.endlessMinImages}`, ctx.lastDiag);
      }

      await waitFor(`${data.planned} unconfirmed bulk downloads to complete`, async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + data.planned;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });
      const written = await expectFilesOnDisk(data.ids, data.planned, 'unconfirmed bulk');

      // The badge is the only feedback a menu user gets, and 12 versus 12? mean very
      // different things. That difference has to survive all the way out here.
      const badge = await swEval(() => chrome.action.getBadgeText({}));
      if (badge !== `${data.planned}?`) {
        throw evidenceError(`the badge reads ${badge}, expected ${data.planned}? - an unconfirmed sweep must not look like a complete one`, { badge, planned: data.planned, warning: data.warning });
      }
      return `${written.count} files grabbed but flagged: badge ${badge}, warning: ${data.warning}`;
    }
  },
  {
    title: 'a flaky server is retried until the file lands, and the growing backoff was really waited out',
    run: async () => {
      ctx.server.reset();
      const fails = EXPECTED.downloads.flakyFailures;
      const imagePath = `/flaky/${fails}/120x90.png`;
      const items = [{ url: ctx.server.origin + imagePath, filename: 'image-grabber/img-901-flaky.png' }];
      const before = await swEval(() => chrome.downloads.search({}).then(i => i.length));
      const run = await downloadWith(items);
      ctx.lastDiag = { run, server: ctx.server.stats() };

      // Non-vacuity first. Had the fixture served the image on the first request there
      // would have been nothing to retry, and every number below would still look
      // perfectly healthy.
      const served = ctx.server.stats()[imagePath];
      if (!served || served.failures !== fails || served.successes !== 1) {
        throw evidenceError(`the fixture served ${served ? served.failures : 0} failure(s) and ${served ? served.successes : 0} success(es), expected ${fails} then 1 - nothing here would be proven`, ctx.lastDiag);
      }

      expect(run.done, 1, 'files downloaded');
      expect(run.failed, 0, 'files failed');
      expect(run.retries, fails, 'retries performed');
      expect(run.warning, null, 'a run where everything landed must not warn');
      const attempts = run.items[0].attempts;
      expect(attempts.length, EXPECTED.downloads.flakyAttempts, 'attempts recorded');
      if (attempts[0].waitedMs !== 0) throw evidenceError('the first attempt waited before even trying', attempts);
      if (attempts.slice(0, -1).some(a => a.reason !== 'SERVER_FAILED' || a.retryable !== true)) {
        throw evidenceError('the failed attempts were not classified as retryable server failures', attempts);
      }

      // The point of the whole step. Two independent readings off the worker's real
      // clock: the wait it measured around its own sleep, and the gap between the
      // previous attempt ending and this one starting. A retry loop that computed the
      // backoff and never awaited it would show ~0 for both.
      const tolerance = EXPECTED.downloads.backoffToleranceRatio;
      const problems = [];
      for (let i = 1; i < attempts.length; i += 1) {
        const planned = attempts[i].plannedWaitMs;
        const measured = attempts[i].waitedMs;
        const gap = attempts[i].startedAt - attempts[i - 1].endedAt;
        if (measured < planned * tolerance) problems.push(`attempt ${i + 1}: measured wait ${measured}ms against a planned ${planned}ms`);
        if (gap < planned * tolerance) problems.push(`attempt ${i + 1}: only ${gap}ms of wall clock between the previous attempt ending and this one starting, planned ${planned}ms`);
        if (i > 1) {
          if (planned <= attempts[i - 1].plannedWaitMs) problems.push(`attempt ${i + 1}: planned wait ${planned}ms did not grow past ${attempts[i - 1].plannedWaitMs}ms`);
          if (measured <= attempts[i - 1].waitedMs) problems.push(`attempt ${i + 1}: measured wait ${measured}ms did not grow past ${attempts[i - 1].waitedMs}ms`);
        }
      }
      if (problems.length) {
        throw evidenceError(`${problems.length} backoff problem(s): the retry either did not wait or did not back off`, { problems, attempts, server: ctx.server.stats() });
      }

      await waitFor('the retried file to reach state=complete', async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + 1;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });
      const written = await expectFilesOnDisk(run.ids, 1, 'retried');

      return `${fails} server failures -> ${attempts.length} attempts, waited ${attempts.map(a => a.waitedMs).join('/')}ms (planned ${attempts.map(a => a.plannedWaitMs).join('/')}), file on disk (${written.bytes}B)`;
    }
  },
  {
    title: 'the worker reports progress while a run is in flight, monotonically, ending at the real total',
    critical: true,
    run: async () => {
      ctx.server.reset();
      const flakyPath = `/flaky/${EXPECTED.downloads.flakyFailures}/180x140.png`;
      const items = [
        { url: ctx.server.origin + '/img/120x90.png', filename: 'image-grabber/img-911-a.png' },
        { url: ctx.server.origin + '/img/160x120.png', filename: 'image-grabber/img-912-b.png' },
        { url: ctx.server.origin + flakyPath, filename: 'image-grabber/img-913-flaky.png' },
        { url: ctx.server.origin + '/img/200x160.png', filename: 'image-grabber/img-914-c.png' }
      ];
      const before = await swEval(() => chrome.downloads.search({}).then(i => i.length));
      const run = await downloadWith(items);
      ctx.mixedRun = run;
      const snapshots = await progressFor(run.runId);
      ctx.lastDiag = { run, snapshots, server: ctx.server.stats() };

      expect(run.total, EXPECTED.downloads.mixedTotal, 'files in the run');
      expect(run.done, EXPECTED.downloads.mixedTotal, 'files downloaded');
      expect(run.retries, EXPECTED.downloads.flakyFailures, 'retries performed');
      if (snapshots.length < EXPECTED.downloads.minProgressEvents) {
        throw evidenceError(`the worker published ${snapshots.length} progress events, expected at least ${EXPECTED.downloads.minProgressEvents}`, ctx.lastDiag);
      }
      const settled = snapshots.map(s => s.settled);
      for (let i = 1; i < settled.length; i += 1) {
        if (settled[i] < settled[i - 1]) throw evidenceError(`progress went backwards: ${settled.join(',')}`, ctx.lastDiag);
      }
      // The assertion that cannot be satisfied by reporting once at the end.
      const distinct = new Set(settled).size;
      if (distinct < EXPECTED.downloads.minDistinctProgress) {
        throw evidenceError(`only ${distinct} distinct progress states were reported (${settled.join(',')}) - progress that only appears when the run is over is not progress`, ctx.lastDiag);
      }
      if (settled[0] !== 0) throw evidenceError('the run did not announce itself before the first file landed', ctx.lastDiag);
      if (!snapshots.some(s => s.retrying > 0)) {
        throw evidenceError('no snapshot ever showed a file as retrying, so the retry was invisible while it happened', ctx.lastDiag);
      }
      const last = snapshots[snapshots.length - 1];
      if (last.settled !== run.total || last.ratio !== 1 || last.complete !== true) {
        throw evidenceError('the final progress event does not match the finished run', { last, run: { total: run.total, done: run.done } });
      }

      await waitFor(`${run.total} mixed downloads to complete`, async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + run.total;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });
      const written = await expectFilesOnDisk(run.ids, run.total, 'mixed');

      return `${snapshots.length} events, ${distinct} distinct states (${settled.join(',')}), ${written.count} files on disk, ${run.retries} retry along the way`;
    }
  },
  {
    title: 'the popup progress bar actually moved during that run, and says what happened',
    run: async () => {
      const state = await diag();
      ctx.lastDiag = state;
      const events = state.progressEvents || [];
      const widths = state.renderedWidths || [];
      if (events.length < EXPECTED.downloads.minProgressEvents) {
        throw evidenceError(`the popup received ${events.length} progress events, expected at least ${EXPECTED.downloads.minProgressEvents}`, { events, download: state.download });
      }
      // Widths are only appended when the painted value CHANGED, so a bar that popped
      // straight to 100% at the end leaves exactly one entry behind.
      if (widths.length < EXPECTED.downloads.minPaintedWidths) {
        throw evidenceError(`the bar was painted at ${widths.length} distinct width(s) (${widths.join(',')}) - a progress bar that only appears at the end is not one`, { widths, download: state.download });
      }
      for (let i = 1; i < widths.length; i += 1) {
        if (widths[i] <= widths[i - 1]) throw evidenceError(`the painted widths do not grow: ${widths.join(',')}`, { widths });
      }
      if (widths[widths.length - 1] !== 100) throw evidenceError(`the bar finished at ${widths[widths.length - 1]}%, expected 100%`, { widths });

      const ui = await ctx.popup.evaluate(() => ({
        hidden: document.getElementById('progress').hidden,
        width: document.getElementById('progressBar').style.width,
        failed: document.getElementById('progressBar').classList.contains('failed'),
        text: document.getElementById('progressText').textContent
      }));
      if (ui.hidden) throw evidenceError('the progress section is hidden after a run that just finished', ui);
      if (ui.width !== '100%') throw evidenceError(`the bar is ${ui.width} wide, expected 100%`, ui);
      if (ui.failed) throw evidenceError('the bar is showing the failure colour after a run where nothing failed', ui);
      const total = EXPECTED.downloads.mixedTotal;
      if (!ui.text.includes(`${total}/${total}`) || !/retried/.test(ui.text)) {
        throw evidenceError(`the progress text reads "${ui.text}", expected it to name ${total}/${total} files and the retry`, ui);
      }
      return `${events.length} events received, bar painted at ${widths.join('% -> ')}%, reading "${ui.text}"`;
    }
  },
  {
    title: 'a download that keeps failing is reported as failed, and the rest of the batch still lands',
    run: async () => {
      await swEval(() => chrome.storage.local.remove('settings'));
      ctx.batch = await ctx.browser.newPage();
      watch(ctx.batch, 'download batch fixture');
      const url = ctx.server.origin + '/downloads.html';
      await ctx.batch.bringToFront();
      await ctx.batch.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const fixture = await ctx.batch.evaluate(() => window.__FIXTURE__);
      const tabId = await resolveTabId(url);
      if (tabId < 0) throw new Error('could not resolve the download batch tab');

      // Non-vacuity: the doomed image has to have RENDERED. If it had failed for the
      // page too, the download failure below could have come from anywhere, and the
      // page would also be logging a console error the last step would trip over.
      if (fixture.doomedLoaded !== true || fixture.brokenImages !== 0) {
        throw evidenceError('the fixture image that is supposed to work exactly once never rendered', { fixture, server: ctx.server.stats() });
      }

      const before = await swEval(() => chrome.downloads.search({}).then(i => i.length));
      const data = await bulkWith(tabId, null);
      ctx.lastDiag = { data, fixture, server: ctx.server.stats() };
      expect(data.planned, EXPECTED.downloads.batchTotal, 'images queued');
      expect(data.downloaded, EXPECTED.downloads.batchDone, 'images that reached disk');
      expect(data.failed, EXPECTED.downloads.batchFailed, 'images reported as failed');

      // A count is not a report. "1 failed" that cannot say which file or why is
      // exactly the kind of evidence-free result this project keeps calling out.
      const failure = (data.failures || [])[0];
      if (!failure || !failure.url.includes('/once/')) {
        throw evidenceError('the failed download was not reported with its url', data.failures);
      }
      if (failure.errorCode !== 'SERVER_FAILED' || !failure.error) {
        throw evidenceError(`the failure came back as ${JSON.stringify(failure.errorCode)} with error ${JSON.stringify(failure.error)}`, failure);
      }
      expect(failure.attempts, DEFAULT_RETRY_OPTIONS.maxAttempts, 'attempts spent on a file that never worked');
      if (!data.downloadWarning || !/could not be downloaded/.test(data.downloadWarning)) {
        throw evidenceError('a batch that lost a file came back without a warning', data);
      }
      const doomedRequests = ctx.server.stats()[fixture.doomed];
      if (!doomedRequests || doomedRequests.failures !== DEFAULT_RETRY_OPTIONS.maxAttempts) {
        throw evidenceError(`the fixture served ${doomedRequests ? doomedRequests.failures : 0} failures for the doomed image, expected ${DEFAULT_RETRY_OPTIONS.maxAttempts}`, ctx.lastDiag);
      }

      await waitFor(`${EXPECTED.downloads.batchDone} healthy downloads to complete`, async () => {
        ctx.downloads = await swEval(() => chrome.downloads.search({}));
        return ctx.downloads.filter(i => i.state === 'complete').length >= before + EXPECTED.downloads.batchDone;
      }, { timeout: DOWNLOAD_TIMEOUT_MS, snapshot: async () => describeDownloads(ctx.downloads) });
      const written = await expectFilesOnDisk(data.ids, EXPECTED.downloads.batchDone, 'partial batch');

      // The badge is the menu user's only feedback, and "2" would be a lie here.
      const badge = await swEval(() => chrome.action.getBadgeText({}));
      if (badge !== `${EXPECTED.downloads.batchDone}/${EXPECTED.downloads.batchTotal}`) {
        throw evidenceError(`the badge reads ${badge}, expected ${EXPECTED.downloads.batchDone}/${EXPECTED.downloads.batchTotal} - a partial batch must not look complete`, { badge, data });
      }
      return `${written.count} of ${data.planned} landed (${written.bytes}B), 1 lost after ${failure.attempts} attempts: ${failure.error}; badge ${badge}`;
    }
  },
  {
    title: 'no uncaught errors in the popup, the page or the service worker',
    run: async () => {
      const swErrors = await swEval(() => self.__DIAG__.errors.slice());
      const popupState = await diag();
      const all = [
        ...ctx.errors,
        ...swErrors.map(e => 'service worker: ' + e),
        ...(popupState ? popupState.errors.map(e => 'popup: ' + e) : [])
      ];
      if (all.length) throw evidenceError(`${all.length} uncaught error(s) during the run`, all.join('\n'));
      return 'clean: no page errors, no console errors, no service worker errors';
    }
  }
];

async function main() {
  let blocked = null;
  for (const step of steps) {
    if (blocked) {
      // Downstream checks after a critical failure only produce noise.
      report.skip(step.title, `blocked by earlier failure: ${blocked}`);
      continue;
    }
    await report.checkAsync(step.title, step.run);
    const last = report.checks[report.checks.length - 1];
    if (!last.ok && step.critical) blocked = step.title;
  }
}

main()
  .catch(err => report.record('gate harness itself crashed', false, err && err.message ? err.message : String(err), err && err.stack))
  .finally(async () => {
    try { if (ctx.browser) await ctx.browser.close(); } catch { /* nothing useful to do */ }
    try { if (ctx.server) await ctx.server.close(); } catch { /* nothing useful to do */ }
    report.save(ARTIFACTS, 'e2e');
    process.stdout.write(`\n${report.name}: ${report.passed}/${report.total} checks passed\n`);
    process.exit(report.ok ? 0 : 1);
  });
