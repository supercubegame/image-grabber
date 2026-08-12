#!/usr/bin/env node
// Fast gate: zero dependencies, seconds to run, executed on every change.
// Anything needing a browser lives in scripts/verify-e2e.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.js';
import { encodePng, decodePng, countDistinctColors } from './lib/png.js';
import { planDownloads, DOWNLOAD_FOLDER, SCAN_ELEMENT_LIMIT } from '../src/core/images.js';
import { SCROLL_OUTCOME, initScrollRun, observeScroll, scrollSummary } from '../src/core/scroll.js';
import {
  MAX_SAFE_BACKOFF_MS,
  WORKER_IDLE_SHUTDOWN_MS,
  mergeRetryOptions,
  classifyFailure,
  backoffSchedule,
  uncappedBackoffSchedule,
  worstCaseItemMs,
  runDownloads
} from '../src/core/retry.js';
import { EXPECTED } from '../test/fixtures/expected.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const UNIT_DIR = path.join(ROOT, 'test', 'unit');
// Guards against the classic false green: a runner that finds nothing still exits 0.
// Today: 64 tests across 8 files. Keep a little slack, not a lot - the point is to
// notice when a file stops being discovered.
const MIN_UNIT_FILES = 8;
const MIN_UNIT_TESTS = 56;
// AGENTS.md says to keep itself under 200 lines, because past that the model it is
// written for starts skimming. It had drifted to 220 before anything checked.
const MAX_RULES_LINES = 200;
const WORKFLOW = '.github/workflows/verify.yml';
// The report job, step by step. supercubegame/jumpwow has the same job with the same
// ids and the same names - two repos writing it separately is how they drift.
//
// The gate locates steps by ID. A display name is a label; an assertion keyed on a
// label turns "rename a step" into "break the gate", which is exactly the tail
// wagging the dog that made the names English here and Chinese there in the first
// place. Names are asserted separately, so a rename goes red on purpose.
const REPORT_STEPS = [
  { id: 'download', name: '下载闸门报告' },
  { id: 'seed', name: '种下兜底评论' },
  { id: 'fetch', name: '取 composer' },
  { id: 'compose', name: '合成报告' },
  { id: 'post', name: '回写报告' },
  { id: 'verdict', name: '闸门失败或报告降级则失败' }
];

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
  const lacking = ['downloads', 'scripting', 'storage', 'tabs', 'contextMenus'].filter(p => !perms.includes(p));
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

// The rules file is the handover to the next agent, and it has two properties that
// only ever degrade quietly: it gets longer, and its copy drifts. Both are cheap to
// check and neither was checked until one of them had already broken.
report.check('the rules files stay short and the two copies stay identical', () => {
  const agents = read('AGENTS.md');
  const claude = read('CLAUDE.md');
  const lines = agents.trimEnd().split('\n').length;
  if (lines > MAX_RULES_LINES) {
    throw fail(`AGENTS.md is ${lines} lines, over its own ${MAX_RULES_LINES}-line limit - cut or split it`, agents.trimEnd().split('\n').map((l, i) => `${i + 1}: ${l}`).slice(-12).join('\n'));
  }
  if (agents !== claude) {
    const a = agents.split('\n');
    const c = claude.split('\n');
    const at = a.findIndex((line, i) => line !== c[i]);
    throw fail(`CLAUDE.md is not a copy of AGENTS.md - they diverge at line ${at + 1}`, `AGENTS.md: ${a[at]}\nCLAUDE.md: ${c[at] === undefined ? '(file ends here)' : c[at]}`);
  }
  return `${lines} lines (limit ${MAX_RULES_LINES}), CLAUDE.md identical`;
});

// Split a job block into its steps. A step starts at six spaces + "- "; its id and
// name live inside it. Locating steps by id is the point: see REPORT_STEPS.
function parseSteps(block) {
  const steps = [];
  let cur = null;
  for (const line of block.split('\n')) {
    if (/^ {6}- \S/.test(line)) {
      cur = { name: null, id: null, lines: [] };
      steps.push(cur);
    }
    if (!cur) continue;
    cur.lines.push(line);
    const named = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (named) cur.name = named[1];
    const identified = /^ {8}id:\s*(\S+)\s*$/.exec(line);
    if (identified) cur.id = identified[1];
  }
  return steps.map((s, i) => ({ ...s, index: i, text: s.lines.join('\n') }));
}

// Run #51: both gates green and not one comment anywhere. The report job's
// actions/checkout failed TLS verification and exited 128 before the write-back
// could run, so from outside the repo the commit looked verified while nothing and
// nobody could read a result. A report that does not arrive did not run.
//
// The fix has four load-bearing parts and every one of them is invisible when it
// breaks, which is exactly why they are asserted here instead of merely written
// down: no clone in that job, a fallback comment seeded before anything that can
// fail, retries on both the fetch and the post, and a degraded report that says so.
report.check('the report job cannot be silenced by a clone, a blip or a missing composer', () => {
  const wf = read(WORKFLOW);
  const jobs = {};
  let current = null;
  let inJobs = false;
  for (const line of wf.split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { current = m[1]; jobs[current] = []; continue; }
    if (current) jobs[current].push(line);
  }
  const summary = jobs.summary ? jobs.summary.join('\n') : null;
  if (!summary) throw fail(`no \`summary:\` job in ${WORKFLOW} - renamed, or this parse is broken`, `jobs found: ${Object.keys(jobs).join(', ') || 'none'}`);
  // Negative twin. An empty or mis-sliced block satisfies every "does not contain"
  // assertion below for free, so prove the parse works first: the two gate jobs DO
  // check the repo out, and have to.
  for (const name of ['fast', 'e2e']) {
    const block = jobs[name] ? jobs[name].join('\n') : '';
    if (!block.includes('actions/checkout')) {
      throw fail(`the \`${name}\` job block contains no actions/checkout, so the workflow parse is wrong and the assertions below prove nothing`, `jobs found: ${Object.keys(jobs).join(', ')}\n---- ${name} block ----\n${block.slice(0, 500)}`);
    }
  }

  const steps = parseSteps(summary);
  const byId = new Map(steps.filter(s => s.id).map(s => [s.id, s]));
  const problems = [];

  if (summary.includes('actions/checkout')) {
    problems.push('the report job checks the repo out again: that is the step that exited 128 in run #51 and took the whole report with it. It needs two script files, not a working tree.');
  }

  // Structure first, by id. Labels come second - see the REPORT_STEPS comment.
  for (const want of REPORT_STEPS) {
    const step = byId.get(want.id);
    if (!step) {
      problems.push(`no step with \`id: ${want.id}\` in the report job - the gate finds steps by id, so a missing one means the structure changed, not just a label`);
      continue;
    }
    if (step.name !== want.name) {
      problems.push(`the step \`id: ${want.id}\` is named ${JSON.stringify(step.name)}, expected ${JSON.stringify(want.name)} - jumpwow's report job uses these exact names, and renaming one here is how the two repos start diverging`);
    }
  }

  const seed = byId.get('seed');
  const fetchStep = byId.get('fetch');
  const post = byId.get('post');

  if (seed && !seed.text.includes('> comment.md')) {
    problems.push('the `seed` step does not write comment.md, so a composer that fails to load leaves the job with nothing to post');
  }
  if (seed && post && seed.index > post.index) {
    problems.push('the fallback comment.md is written AFTER the post step, which is the same as not writing it at all');
  }
  if (fetchStep && !/--retry\b/.test(fetchStep.text)) {
    problems.push('the `fetch` step carries no --retry, so a single transient blip silences the report exactly as before');
  }
  if (!summary.includes('report-degraded.flag')) {
    problems.push('nothing marks a degraded report: a comment carrying only job results must never read like a complete one');
  }
  if (post) {
    if (/continue-on-error:\s*true/.test(post.text)) problems.push('the post step is continue-on-error: a monitor allowed to fail quietly is worse than no monitor');
    if (!/for \(let attempt/.test(post.text)) problems.push('the post step does not retry, and posting is a network call like any other');
    if (!/readback/.test(post.text)) problems.push('the post step never reads the comment back: an accepted API call is not a comment anybody can read');
  }

  if (problems.length) {
    const seen = steps.map(s => `${s.id || '(no id)'} — ${s.name === null ? '(no name)' : s.name}`).join('\n');
    throw fail(`${problems.length} way(s) the report could go missing again`, `${problems.join('\n')}\n---- steps found in the report job ----\n${seen}`);
  }
  return `${REPORT_STEPS.length} steps found by id with the expected names; no checkout, fallback seeded before the post, fetch retried, post retried and read back, degraded reports flagged red`;
});

// An injected classic script cannot import the core, so the element limit exists
// twice on purpose. A drift between the copies is invisible from the outside: the
// scan keeps working and only the truncation REPORT starts lying - which is the one
// thing that feature exists to get right. The fixture belongs in the same check,
// because a fixture that no longer exceeds the limit turns the browser gate's
// truncation step into a check that passes against a perfectly complete scan.
report.check('the element limit is one number everywhere that depends on it', () => {
  const collectSrc = read('src/content/collect.js');
  const fixtureSrc = read('test/fixtures/many-elements.html');
  const inCollector = /const\s+MAX_ELEMENTS\s*=\s*(\d+)/.exec(collectSrc);
  if (!inCollector) throw fail('MAX_ELEMENTS is not declared in src/content/collect.js - renamed, or the walk lost its cap?', tail(collectSrc, 30));
  const inFixture = /const\s+FILLER_COUNT\s*=\s*(\d+)/.exec(fixtureSrc);
  if (!inFixture) throw fail('FILLER_COUNT is not declared in test/fixtures/many-elements.html - the truncation fixture cannot be verified', tail(fixtureSrc, 30));
  const collector = Number(inCollector[1]);
  const filler = Number(inFixture[1]);
  const problems = [];
  if (collector !== SCAN_ELEMENT_LIMIT) {
    problems.push(`collect.js walks ${collector} elements, the core reports the limit as ${SCAN_ELEMENT_LIMIT} - every coverage number would be computed against the wrong cap`);
  }
  if (filler <= SCAN_ELEMENT_LIMIT) {
    problems.push(`many-elements.html builds ${filler} filler elements against a ${SCAN_ELEMENT_LIMIT} limit: the page would be inspected in FULL, and the truncation step would pass without ever truncating anything`);
  }
  if (EXPECTED.coverage.fillerCount !== filler) {
    problems.push(`EXPECTED.coverage.fillerCount is ${EXPECTED.coverage.fillerCount} but the fixture builds ${filler}`);
  }
  if (problems.length) throw fail(`${problems.length} element-limit mismatch(es)`, problems.join('\n'));
  return `${SCAN_ELEMENT_LIMIT} in both the core and the collector; the fixture builds ${filler}, ${filler - SCAN_ELEMENT_LIMIT} past the cap`;
});

// Both download triggers - the popup button and the page context menu - build
// their paths here, so a hole in this function is a hole in a page's ability to
// write outside the download folder.
report.check('planDownloads keeps hostile page URLs inside the download folder', () => {
  const base = { width: 10, height: 10, format: 'png', isData: false, occurrences: 1 };
  const hostile = [
    { url: 'https://e.com/../../../etc/passwd.png' },
    { url: 'https://e.com/a/..%2f..%2fescape.png' },
    { url: 'https://e.com/%2e%2e/%2e%2e/x.jpg', format: 'jpg' },
    { url: 'https://e.com/dir/sub/', format: 'other' },
    { url: 'https://e.com/name with spaces & symbols.PNG' },
    { url: 'https://e.com/' + 'x'.repeat(300) + '.png' },
    { url: 'https://e.com/.hidden/..png' },
    { url: 'data:image/png;base64,AAAA', isData: true }
  ].map(over => ({ ...base, ...over }));

  const plan = planDownloads(hostile, { includeDataUrls: true, filenamePrefix: '../../etc' });
  // Without this the whole check goes vacuous: an empty plan satisfies every
  // "no bad path" assertion below.
  if (plan.length !== hostile.length) {
    throw fail(`planned ${plan.length} of ${hostile.length} downloads - the filters dropped inputs this check exists to cover`, JSON.stringify(plan, null, 2));
  }
  const shape = new RegExp(`^${DOWNLOAD_FOLDER}/[a-z0-9][a-z0-9._-]*\\.[a-z0-9]+$`);
  const bad = plan.filter(entry =>
    !shape.test(entry.filename) ||
    entry.filename.includes('..') ||
    entry.filename.includes('\\') ||
    entry.filename.split('/').length !== 2
  );
  if (bad.length) throw fail(`${bad.length} of ${plan.length} planned paths escape or malform the download folder`, bad.map(b => b.filename).join('\n'));
  const longest = plan.reduce((max, e) => Math.max(max, e.filename.length), 0);
  return `${plan.length} hostile urls -> ${plan.length} paths, all matching ${DOWNLOAD_FOLDER}/<safe name> (longest ${longest} chars)`;
});

// The one decision auto-scroll makes. Getting it wrong in the safe direction costs
// a few extra scrolls; getting it wrong in the other direction hands the user a
// half-scraped page that claims to be complete, which is the failure this whole
// feature has to avoid.
report.check('the scroll state machine tells a confirmed bottom apart from giving up', () => {
  const drive = (options, measurements) => {
    let run = initScrollRun({ enabled: true, ...options });
    let elapsed = 0;
    for (const measurement of measurements) {
      elapsed += 100;
      run = observeScroll(run, measurement, elapsed);
      if (run.done) break;
    }
    return scrollSummary(run);
  };
  const still = n => new Array(n).fill(0).map(() => ({ imageCount: 12, scrollHeight: 4800 }));
  const growing = n => new Array(n).fill(0).map((_, i) => ({ imageCount: 12 + i * 2, scrollHeight: 4800 + i * 800 }));
  const roomy = { stableRounds: 3, maxScrolls: 50, timeoutMs: 60000 };

  const cases = [
    { name: 'four identical rounds settle', options: roomy, feed: still(4), outcome: SCROLL_OUTCOME.SETTLED, reachedEnd: true },
    { name: 'three identical rounds are one short', options: roomy, feed: still(3), outcome: null, reachedEnd: false },
    { name: 'endless growth vs the scroll cap', options: { ...roomy, maxScrolls: 6 }, feed: growing(30), outcome: SCROLL_OUTCOME.MAX_SCROLLS, reachedEnd: false },
    { name: 'endless growth vs the total timeout', options: { ...roomy, timeoutMs: 250 }, feed: growing(30), outcome: SCROLL_OUTCOME.TIMEOUT, reachedEnd: false },
    { name: 'the optional image cap', options: { ...roomy, maxImages: 16 }, feed: growing(30), outcome: SCROLL_OUTCOME.IMAGE_CAP, reachedEnd: true }
  ];

  const wrong = [];
  for (const scenario of cases) {
    const summary = drive(scenario.options, scenario.feed);
    if (summary.outcome !== scenario.outcome || summary.reachedEnd !== scenario.reachedEnd) {
      wrong.push(`${scenario.name}: expected outcome=${scenario.outcome} reachedEnd=${scenario.reachedEnd}, got outcome=${summary.outcome} reachedEnd=${summary.reachedEnd}`);
      continue;
    }
    // The user-facing pair: exactly one of "we reached the end" and "here is why we
    // did not" may be present. Both or neither means the report lies somewhere.
    const warned = typeof summary.warning === 'string' && summary.warning.length > 0;
    if (warned === summary.reachedEnd) {
      wrong.push(`${scenario.name}: reachedEnd=${summary.reachedEnd} alongside warning=${JSON.stringify(summary.warning)}`);
    }
  }
  if (wrong.length) throw fail(`${wrong.length} of ${cases.length} scroll outcomes are wrong`, wrong.join('\n'));
  return `${cases.length} outcomes correct; only ${SCROLL_OUTCOME.SETTLED}/${SCROLL_OUTCOME.IMAGE_CAP} report reachedEnd, both safety nets warn`;
});

// Retrying the wrong things is worse than not retrying: it turns a clear 404 into
// three of them and a cancelled download into a fight with the user.
report.check('failure reasons split into retryable and permanent, and an unknown reason is never retried', () => {
  const retryable = ['SERVER_FAILED', 'SERVER_UNREACHABLE', 'SERVER_CONTENT_LENGTH_MISMATCH', 'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'FILE_TRANSIENT_ERROR', 'CRASH', 'DOWNLOAD_TIMEOUT'];
  const permanent = ['USER_CANCELED', 'USER_SHUTDOWN', 'SERVER_BAD_CONTENT', 'SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'NETWORK_INVALID_REQUEST', 'FILE_ACCESS_DENIED', 'FILE_NO_SPACE', 'FILE_VIRUS_INFECTED'];
  // Non-vacuity: two empty lists would satisfy every loop below.
  if (retryable.length < 3 || permanent.length < 3) throw fail('one of the reason buckets is too small to prove anything', JSON.stringify({ retryable, permanent }));
  const wrong = [];
  for (const reason of retryable) {
    const verdict = classifyFailure(reason);
    if (!verdict.retryable || !verdict.known) wrong.push(`${reason}: expected a known transient failure, got ${JSON.stringify(verdict)}`);
  }
  for (const reason of permanent) {
    const verdict = classifyFailure(reason);
    if (verdict.retryable || !verdict.known) wrong.push(`${reason}: expected a known final answer, got ${JSON.stringify(verdict)}`);
  }
  const unknown = classifyFailure('WAT_JUST_HAPPENED');
  if (unknown.retryable || unknown.known) wrong.push(`an unclassified reason must be reported as unknown and NOT retried, got ${JSON.stringify(unknown)}`);
  const missing = classifyFailure(null);
  if (missing.retryable || missing.code !== 'UNKNOWN') wrong.push(`a missing reason must not be retried, got ${JSON.stringify(missing)}`);
  if (wrong.length) throw fail(`${wrong.length} reason(s) classified wrongly`, wrong.join('\n'));
  return `${retryable.length} transient + ${permanent.length} final reasons classified; unknown and missing both default to permanent`;
});

// The retry parameters are a group, not five independent knobs. This is the check
// that makes the coupled-parameters block in AGENTS.md enforceable instead of
// aspirational.
report.check('the retry budgets line up with each other and with the browser gate', () => {
  const options = mergeRetryOptions(null);
  const schedule = backoffSchedule(options);
  const worstItem = worstCaseItemMs(options);
  const problems = [];

  if (options.maxAttempts < 3) problems.push(`maxAttempts=${options.maxAttempts} leaves at most one wait, so nothing can demonstrate growth`);
  if (schedule.length !== options.maxAttempts - 1) problems.push(`the schedule has ${schedule.length} waits for ${options.maxAttempts} attempts`);
  for (let i = 1; i < schedule.length; i += 1) {
    if (schedule[i] <= schedule[i - 1] && schedule[i] < options.backoffMaxMs) {
      problems.push(`wait ${i + 1} (${schedule[i]}ms) does not grow past wait ${i} (${schedule[i - 1]}ms) and is not at the ${options.backoffMaxMs}ms cap`);
    }
  }
  const longest = schedule.length ? Math.max(...schedule) : 0;
  if (longest > MAX_SAFE_BACKOFF_MS) {
    problems.push(`the longest wait is ${longest}ms, past the ${MAX_SAFE_BACKOFF_MS}ms ceiling that keeps a bare sleep well inside the worker's ~${WORKER_IDLE_SHUTDOWN_MS}ms idle shutdown`);
  }
  if (worstItem >= EXPECTED.downloads.gateTimeoutMs) {
    problems.push(`one worst-case file takes ${worstItem}ms, at or past the browser gate's ${EXPECTED.downloads.gateTimeoutMs}ms download wait - a bad file would time the gate out instead of failing it`);
  }
  if (options.runTimeoutMs < worstItem * 2) {
    problems.push(`runTimeoutMs ${options.runTimeoutMs}ms cannot cover two worst-case files (${worstItem}ms each), so a normal run would start reporting files as skipped`);
  }
  if (EXPECTED.downloads.flakyFailures >= options.maxAttempts) {
    problems.push(`the flaky fixture fails ${EXPECTED.downloads.flakyFailures}x against maxAttempts=${options.maxAttempts}: the browser gate would be asserting a give-up, not a retry`);
  }
  if (EXPECTED.downloads.flakyAttempts !== EXPECTED.downloads.flakyFailures + 1) {
    problems.push(`flakyAttempts (${EXPECTED.downloads.flakyAttempts}) should be flakyFailures + 1 (${EXPECTED.downloads.flakyFailures + 1})`);
  }
  if (problems.length) throw fail(`${problems.length} retry budget(s) do not line up`, problems.join('\n'));
  return `${options.maxAttempts} attempts, waits ${schedule.join('+')}ms (cap ${options.backoffMaxMs}), worst file ${worstItem}ms < gate ${EXPECTED.downloads.gateTimeoutMs}ms, run budget ${options.runTimeoutMs}ms`;
});

// A cap the schedule can never reach is a constant with a comment attached. This
// one sat at 4000ms against a schedule that stopped at 1000ms and no assertion had
// anything to say about it, which is the same shape of hole as the colour floor:
// green, permanent, and invisible until somebody does the arithmetic by hand.
report.check('the backoff cap is a real bound on the DEFAULT schedule, not decoration', () => {
  const options = mergeRetryOptions(null);
  const capped = backoffSchedule(options);
  const uncapped = uncappedBackoffSchedule(options);
  const clipped = capped.filter((ms, i) => uncapped[i] > ms);
  if (!clipped.length) {
    throw fail(
      `backoffMaxMs is ${options.backoffMaxMs}ms but the schedule tops out at ${Math.max(...uncapped)}ms - the cap can never fire, so it proves nothing and protects nothing`,
      `capped:   ${capped.join(', ')}\nuncapped: ${uncapped.join(', ')}\nlower the cap below ${Math.max(...uncapped)}ms, or raise maxAttempts until the schedule reaches it`
    );
  }
  // The other direction: a cap so low that even the first retry is clipped means
  // there is no growth left to observe, and "exponential backoff" is a fixed delay.
  if (capped[0] !== uncapped[0] || capped.length < 2 || capped[1] <= capped[0]) {
    throw fail(`the cap clips from the very first wait (${capped.join(', ')}), which flattens the backoff into a fixed delay`, `uncapped: ${uncapped.join(', ')}`);
  }
  return `waits ${capped.join('/')}ms - ${clipped.length} of ${capped.length} clipped by the ${options.backoffMaxMs}ms cap (uncapped: ${uncapped.join('/')}ms)`;
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

// The one thing about a backoff that has to be PROVEN rather than read: that it was
// actually awaited. The clock below only moves when the driver asks to wait, so a
// driver that computed the delays and skipped them would produce an empty wait log
// and every attempt would land on the same instant.
await report.checkAsync('the retry driver really awaits its backoff, in order, for growing durations', async () => {
  const options = mergeRetryOptions({ maxAttempts: 4, backoffBaseMs: 100, backoffFactor: 3, backoffMaxMs: 5000 });
  const log = [];
  let clock = 0;
  const result = await runDownloads({
    items: [{ url: 'https://example.test/a.png', filename: 'image-grabber/img-001-a.png' }],
    options,
    now: () => clock,
    wait: async ms => { log.push(`wait:${ms}`); clock += ms; },
    start: async (record, context) => {
      log.push(`attempt:${context.attempt}@${clock}`);
      clock += 10;
      return context.attempt < 4
        ? { ok: false, reason: 'SERVER_FAILED' }
        : { ok: true, id: 7, filename: '/tmp/a.png', bytes: 128 };
    }
  });
  const expectedLog = ['attempt:1@0', 'wait:100', 'attempt:2@110', 'wait:300', 'attempt:3@420', 'wait:900', 'attempt:4@1330'];
  if (log.join(' | ') !== expectedLog.join(' | ')) {
    throw fail('the attempt/wait interleaving is wrong - the backoff was skipped, reordered or the wrong length', `expected: ${expectedLog.join(' | ')}\nactual:   ${log.join(' | ')}`);
  }
  const attempts = result.items[0].attempts;
  const waited = attempts.map(a => a.waitedMs);
  if (waited.join(',') !== '0,100,300,900') {
    throw fail(`recorded waits are ${waited.join(',')}, expected 0,100,300,900`, JSON.stringify(attempts, null, 2));
  }
  const gaps = attempts.slice(1).map((a, i) => a.startedAt - attempts[i].endedAt);
  if (gaps.join(',') !== '100,300,900') {
    throw fail(`the clock moved by ${gaps.join(',')}ms between attempts, expected 100,300,900`, JSON.stringify(attempts, null, 2));
  }
  if (result.done !== 1 || result.retries !== 3 || result.attempts !== 4) {
    throw fail(`the run reported done=${result.done} retries=${result.retries} attempts=${result.attempts}, expected 1/3/4`, JSON.stringify(result, null, 2));
  }
  return `4 attempts interleaved with waits of ${waited.slice(1).join('/')}ms on a clock the driver does not own`;
});

report.save(ARTIFACTS, 'fast');
process.stdout.write(`\n${report.name}: ${report.passed}/${report.total} checks passed\n`);
process.exit(report.ok ? 0 : 1);
