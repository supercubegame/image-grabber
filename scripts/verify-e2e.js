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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
// Coupled with PROBE_TIMEOUT_MS (4000) in src/popup/popup.js: polling has to outlast
// the worst-case image probe or every scan assertion becomes a flaky timeout.
// Change one, recheck the other (AGENTS.md).
const POLL_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 40000;
const LAUNCH_TIMEOUT_MS = 60000;

const report = new Report('browser gate');
const ctx = { errors: [], screenshots: {}, lastDiag: null };

fs.mkdirSync(ARTIFACTS, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Predicates MUST return a real boolean. Returning a count means 0 reads as "not
// ready yet" and the failure surfaces as a timeout instead of a wrong value.
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

async function openPopup(tabId) {
  const target = tabId === undefined ? ctx.tabId : tabId;
  await ctx.popup.goto(`chrome-extension://${ctx.extId}/src/popup/popup.html?tabId=${target}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await waitFor('popup phase to reach "ready"', async () => {
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
      return `"${info.name}" v${info.version} loaded as ${ctx.extId}, fixtures on ${ctx.server.origin}`;
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
      ctx.tabId = await swEval(async (url) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find(t => t.url === url);
        return hit ? hit.id : -1;
      }, ctx.pageUrl);
      if (ctx.tabId < 0) throw new Error('the extension could not find the fixture tab');
      return `tab ${ctx.tabId} serving ${imgCount} <img> elements`;
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
      ctx.colorsEmpty = countDistinctColors(decodePng(await shoot('popup-empty.png')), 3);
      return `0 rows, empty state shown, ${ctx.colorsEmpty} distinct colours on screen`;
    }
  },
  {
    title: 'the populated list actually paints pixels (colour delta vs empty state)',
    run: async () => {
      await setNumber('minWidth', 0);
      await waitForVisible(EXPECTED.defaultVisible);
      await waitFor('thumbnails to decode', async () => ctx.popup.evaluate(
        () => Array.from(document.querySelectorAll('img.thumb')).every(i => i.complete && i.naturalWidth > 0)
      ));
      ctx.colorsPopulated = countDistinctColors(decodePng(await shoot('popup-populated.png')), 3);
      const delta = ctx.colorsPopulated - ctx.colorsEmpty;
      if (ctx.colorsPopulated < EXPECTED.minColorsPopulated) {
        throw evidenceError(`populated popup shows only ${ctx.colorsPopulated} distinct colours, expected at least ${EXPECTED.minColorsPopulated}`, { empty: ctx.colorsEmpty, populated: ctx.colorsPopulated });
      }
      if (delta < EXPECTED.minColorDelta) {
        throw evidenceError(`colour delta is ${delta}, expected at least ${EXPECTED.minColorDelta}`, { empty: ctx.colorsEmpty, populated: ctx.colorsPopulated });
      }
      return `${ctx.colorsEmpty} -> ${ctx.colorsPopulated} distinct colours (delta ${delta})`;
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
      const tabId = await swEval(async (u) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find(t => t.url === u);
        return hit ? hit.id : -1;
      }, url);
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
