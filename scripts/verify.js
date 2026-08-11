#!/usr/bin/env node
// Fast gate: zero dependencies, seconds to run, executed on every change.
// Anything needing a browser lives in scripts/verify-e2e.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.js';
import { encodePng, decodePng, countDistinctColors } from './lib/png.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const UNIT_DIR = path.join(ROOT, 'test', 'unit');
// Guards against the classic false green: a runner that finds nothing still exits 0.
const MIN_UNIT_FILES = 3;
const MIN_UNIT_TESTS = 12;

const report = new Report('fast gate');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

function fail(message, evidence) {
  const err = new Error(message);
  err.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  return err;
}

function tail(text, lines = 60) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

report.check('manifest.json is valid MV3 and references only files that exist', () => {
  const manifest = JSON.parse(read('manifest.json'));
  if (manifest.manifest_version !== 3) throw new Error(`manifest_version is ${manifest.manifest_version}, expected 3`);
  const refs = [];
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker);
  for (const icon of Object.values(manifest.icons || {})) refs.push(icon);
  if (!refs.length) throw new Error('manifest references no files at all');
  const missing = refs.filter(r => !exists(r));
  if (missing.length) throw fail('manifest references missing files: ' + missing.join(', '), refs.join('\n'));
  const perms = manifest.permissions || [];
  const lacking = ['downloads', 'scripting', 'storage', 'tabs'].filter(p => !perms.includes(p));
  if (lacking.length) throw fail('missing permissions: ' + lacking.join(', '), JSON.stringify(manifest.permissions));
  return `MV3, ${refs.length} referenced files present, permissions ${perms.join('/')}`;
});

report.check('files injected or linked at runtime exist on disk', () => {
  const sw = read('src/background/service_worker.js');
  // Injected paths are usually referenced through a const, not written inline, so
  // resolve identifiers as well. Matching only quoted literals made this check
  // report "no content script found" while the injection was working fine.
  const constants = new Map();
  for (const m of sw.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g)) constants.set(m[1], m[2]);
  const blocks = Array.from(sw.matchAll(/files:\s*\[([^\]]*)\]/g)).map(m => m[1]);
  if (!blocks.length) throw fail('no files: [...] injection found in the service worker - did the injection move?', tail(sw, 40));
  const injected = [];
  const unresolved = [];
  for (const block of blocks) {
    for (const token of block.split(',').map(t => t.trim()).filter(Boolean)) {
      const quoted = /^['"]([^'"]+)['"]$/.exec(token);
      if (quoted) injected.push(quoted[1]);
      else if (constants.has(token)) injected.push(constants.get(token));
      else unresolved.push(token);
    }
  }
  if (unresolved.length) throw fail('could not resolve injected script reference(s): ' + unresolved.join(', '), Array.from(constants.entries()).map(e => e.join(' = ')).join('\n'));
  if (!injected.length) throw fail('the service worker injects nothing', tail(sw, 40));
  const html = read('src/popup/popup.html');
  const linked = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
    .map(m => m[1])
    .filter(h => !h.startsWith('http') && !h.startsWith('data:'));
  if (!linked.length) throw new Error('popup.html links no local assets - the parse probably broke');
  const missing = [];
  for (const f of injected) if (!exists(f)) missing.push(f);
  for (const f of linked) if (!exists(path.posix.join('src/popup', f))) missing.push('src/popup/' + f);
  if (missing.length) throw fail('missing files: ' + missing.join(', '), [...injected, ...linked].join('\n'));
  return `${injected.length} injected (${injected.join(', ')}) + ${linked.length} linked assets present`;
});

report.check('src/core stays pure (no DOM, chrome API, clock or unseeded randomness)', () => {
  const dir = path.join(ROOT, 'src', 'core');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  if (!files.length) throw new Error('src/core contains no .js files');
  const banned = [/\bdocument\./, /\bwindow\./, /\bchrome\./, /Date\.now\s*\(/, /new Date\s*\(/, /Math\.random\s*\(/, /\brequire\s*\(/, /from ['"]node:/];
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      for (const re of banned) if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  if (hits.length) throw fail(`core is not pure any more (${hits.length} offending lines)`, hits.join('\n'));
  return `${files.length} core file(s) clean`;
});

report.check('png codec round-trips (the gate\'s own screenshot tooling)', () => {
  const png = encodePng(8, 8, (x, y) => [x * 30, y * 30, (x + y) * 15, 255]);
  const decoded = decodePng(png);
  if (decoded.width !== 8 || decoded.height !== 8) throw new Error(`round-trip size ${decoded.width}x${decoded.height}, expected 8x8`);
  const i = (3 * 8 + 5) * decoded.bpp;
  const got = [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]];
  const want = [5 * 30, 3 * 30, (5 + 3) * 15];
  if (got.join(',') !== want.join(',')) throw fail(`pixel (5,3) is ${got.join(',')}, expected ${want.join(',')}`, JSON.stringify({ got, want }));
  const colors = countDistinctColors(decoded, 1);
  if (colors < 32) throw new Error(`gradient decoded to only ${colors} distinct colours`);
  return `encode/decode exact, ${colors} distinct colours in an 8x8 gradient`;
});

report.check('unit tests are discovered, actually execute and all pass', () => {
  if (!fs.existsSync(UNIT_DIR)) throw new Error('test/unit is missing');
  const files = fs.readdirSync(UNIT_DIR).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(UNIT_DIR, f));
  if (files.length < MIN_UNIT_FILES) throw fail(`found ${files.length} unit test files, expected at least ${MIN_UNIT_FILES} - tests were moved or deleted`, files.join('\n'));
  // Files are enumerated explicitly: directory arguments and shell globs are exactly
  // how a runner ends up reporting success without running a single test.
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ROOT, encoding: 'utf8' });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const num = re => { const m = re.exec(out); return m ? Number(m[1]) : null; };
  const tests = num(/^# tests (\d+)/m);
  const passed = num(/^# pass (\d+)/m);
  const failed = num(/^# fail (\d+)/m);
  if (tests === null) throw fail('no TAP summary from the runner - the tests never ran', tail(out));
  if (tests < MIN_UNIT_TESTS) throw fail(`only ${tests} tests executed, expected at least ${MIN_UNIT_TESTS}`, tail(out));
  if (failed !== 0 || res.status !== 0) throw fail(`${failed} of ${tests} unit tests failed (exit ${res.status})`, tail(out, 120));
  return `${passed}/${tests} unit tests passed across ${files.length} files`;
});

report.save(ARTIFACTS, 'fast');
process.stdout.write(`\n${report.name}: ${report.passed}/${report.total} checks passed\n`);
process.exit(report.ok ? 0 : 1);
