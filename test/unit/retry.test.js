// The retry driver, driven by a clock the TEST owns.
//
// Nothing in here advances time except a wait the driver actually performed. That
// is the whole point: a driver that computes a 500ms backoff and then never awaits
// it looks identical from the outside, and only a fake clock can tell the
// difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_OPTIONS,
  DOWNLOAD_STATE,
  mergeRetryOptions,
  classifyFailure,
  backoffFor,
  backoffSchedule,
  worstCaseItemMs,
  runDownloads
} from '../../src/core/retry.js';

const FAIL = reason => ({ ok: false, reason });
const OK = index => ({ ok: true, id: 100 + index, filename: `/tmp/${index}.png`, bytes: 64 });

// `script(index, attempt)` decides what each attempt does. `log` records attempts
// and waits in the order they happened; `attemptCostMs` is how long an attempt
// itself takes on the fake clock.
function drive({ files = 1, options, script, attemptCostMs = 10 }) {
  const log = [];
  const progress = [];
  const clock = { now: 0 };
  const items = new Array(files).fill(0).map((_, index) => ({
    url: `https://example.test/${index}.png`,
    filename: `image-grabber/img-00${index}.png`
  }));
  const run = runDownloads({
    items,
    options,
    now: () => clock.now,
    wait: async ms => {
      log.push(`wait:${ms}`);
      clock.now += ms;
    },
    start: async (record, context) => {
      log.push(`attempt:${record.index}.${context.attempt}@${clock.now}`);
      clock.now += attemptCostMs;
      return script(record.index, context.attempt);
    },
    onProgress: snapshot => progress.push(snapshot)
  });
  return { run, log, progress, clock };
}

test('mergeRetryOptions fills the defaults and refuses nonsense', () => {
  assert.deepEqual(mergeRetryOptions(null), { ...DEFAULT_RETRY_OPTIONS });
  assert.deepEqual(mergeRetryOptions({ maxAttempts: 'seven' }), { ...DEFAULT_RETRY_OPTIONS });
  const clamped = mergeRetryOptions({ maxAttempts: 0, backoffFactor: 0, perDownloadTimeoutMs: 1, backoffBaseMs: -5 });
  assert.equal(clamped.maxAttempts, 1, 'at least one attempt or nothing is ever tried');
  assert.equal(clamped.backoffFactor, 1, 'a factor below 1 would shrink the backoff');
  assert.equal(clamped.perDownloadTimeoutMs, 100);
  assert.equal(clamped.backoffBaseMs, 0);
});

test('a server or network hiccup is worth retrying', () => {
  for (const reason of ['SERVER_FAILED', 'SERVER_UNREACHABLE', 'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'CRASH', 'DOWNLOAD_TIMEOUT']) {
    const verdict = classifyFailure(reason);
    assert.equal(verdict.retryable, true, `${reason} should be retryable`);
    assert.equal(verdict.known, true, `${reason} should be a known reason`);
    assert.equal(verdict.code, reason);
  }
});

test('a final answer is never retried', () => {
  for (const reason of ['USER_CANCELED', 'SERVER_BAD_CONTENT', 'SERVER_FORBIDDEN', 'FILE_ACCESS_DENIED', 'FILE_NO_SPACE', 'NETWORK_INVALID_REQUEST']) {
    const verdict = classifyFailure(reason);
    assert.equal(verdict.retryable, false, `${reason} should not be retryable`);
    assert.equal(verdict.known, true, `${reason} should be a known reason`);
  }
});

test('an unrecognised or missing reason is permanent, and says so', () => {
  const unknown = classifyFailure('WAT_JUST_HAPPENED');
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.known, false, 'the report has to be able to say nobody classified this');
  assert.equal(unknown.code, 'WAT_JUST_HAPPENED');
  for (const missing of [null, undefined, '', '   ']) {
    const verdict = classifyFailure(missing);
    assert.equal(verdict.retryable, false);
    assert.equal(verdict.code, 'UNKNOWN');
  }
  // Case is not something a caller should have to get right.
  assert.equal(classifyFailure('server_failed').retryable, true);
});

test('the backoff grows exponentially and there is one wait per retry', () => {
  const options = mergeRetryOptions({ maxAttempts: 4, backoffBaseMs: 250, backoffFactor: 2, backoffMaxMs: 60000 });
  assert.deepEqual(backoffSchedule(options), [250, 500, 1000]);
  assert.equal(backoffSchedule(options).length, options.maxAttempts - 1);
  assert.equal(backoffFor(1, options), 250);
  assert.equal(backoffFor(3, options), 1000);
  const schedule = backoffSchedule(options);
  for (let i = 1; i < schedule.length; i += 1) {
    assert.ok(schedule[i] > schedule[i - 1], `wait ${i + 1} (${schedule[i]}ms) must grow past ${schedule[i - 1]}ms`);
  }
});

test('the backoff is capped, and the cap is what bounds a whole run', () => {
  const options = mergeRetryOptions({ maxAttempts: 6, backoffBaseMs: 1000, backoffFactor: 10, backoffMaxMs: 4000 });
  assert.deepEqual(backoffSchedule(options), [1000, 4000, 4000, 4000, 4000]);
  assert.equal(Math.max(...backoffSchedule(options)), options.backoffMaxMs);
  // maxAttempts * perDownloadTimeoutMs + every wait. Used by the fast gate to keep
  // one bad file from timing the browser gate out instead of failing it.
  const worst = worstCaseItemMs({ maxAttempts: 2, perDownloadTimeoutMs: 1000, backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 4000 });
  assert.equal(worst, 2 * 1000 + 500);
});

test('the driver AWAITS its backoff between attempts, in order', async () => {
  const harness = drive({
    options: { maxAttempts: 4, backoffBaseMs: 100, backoffFactor: 3, backoffMaxMs: 5000 },
    script: (index, attempt) => (attempt < 4 ? FAIL('SERVER_FAILED') : OK(index))
  });
  const result = await harness.run;
  // If the driver ever skipped the wait, there would be no wait entries here at all
  // and the attempt timestamps would all collapse onto the same instant.
  assert.deepEqual(harness.log, [
    'attempt:0.1@0',
    'wait:100',
    'attempt:0.2@110',
    'wait:300',
    'attempt:0.3@420',
    'wait:900',
    'attempt:0.4@1330'
  ]);
  assert.equal(result.done, 1);
  assert.equal(result.retries, 3);
  assert.equal(result.attempts, 4);
});

test('the first attempt never waits, and every recorded wait grows', async () => {
  const harness = drive({
    options: { maxAttempts: 4, backoffBaseMs: 100, backoffFactor: 3, backoffMaxMs: 5000 },
    script: (index, attempt) => (attempt < 4 ? FAIL('NETWORK_FAILED') : OK(index))
  });
  const result = await harness.run;
  const attempts = result.items[0].attempts;
  assert.deepEqual(attempts.map(a => a.plannedWaitMs), [0, 100, 300, 900]);
  assert.deepEqual(attempts.map(a => a.waitedMs), [0, 100, 300, 900]);
  for (let i = 1; i < attempts.length; i += 1) {
    const gap = attempts[i].startedAt - attempts[i - 1].endedAt;
    assert.equal(gap, attempts[i].plannedWaitMs, `the clock has to move by the backoff between attempts ${i} and ${i + 1}`);
    if (i > 1) assert.ok(attempts[i].waitedMs > attempts[i - 1].waitedMs, 'waits must keep growing');
  }
});

test('a permanent failure is not retried at all', async () => {
  const harness = drive({
    options: { maxAttempts: 5, backoffBaseMs: 100 },
    script: () => FAIL('SERVER_BAD_CONTENT')
  });
  const result = await harness.run;
  assert.deepEqual(harness.log, ['attempt:0.1@0'], 'one attempt, and no wait after it');
  assert.equal(result.failed, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.items[0].state, DOWNLOAD_STATE.FAILED);
  assert.equal(result.items[0].errorCode, 'SERVER_BAD_CONTENT');
  assert.match(result.items[0].error, /not worth retrying/);
});

test('every requested file is accounted for, and the warning appears exactly when one did not land', async () => {
  const clean = await drive({ files: 3, script: (index) => OK(index) }).run;
  assert.equal(clean.done + clean.failed + clean.skipped, clean.total);
  assert.equal(clean.complete, true);
  assert.equal(clean.warning, null, 'a clean run must not warn');
  assert.deepEqual(clean.ids, [100, 101, 102]);

  const partial = await drive({
    files: 3,
    options: { maxAttempts: 2, backoffBaseMs: 10 },
    script: (index) => (index === 1 ? FAIL('FILE_ACCESS_DENIED') : OK(index))
  }).run;
  assert.equal(partial.done, 2);
  assert.equal(partial.failed, 1);
  assert.equal(partial.done + partial.failed + partial.skipped, partial.total);
  assert.equal(partial.complete, false);
  assert.ok(partial.warning && partial.warning.includes('could not be downloaded'), 'a partial run must warn');
  assert.equal(partial.failures.length, 1);
  assert.equal(partial.failures[0].filename, 'image-grabber/img-001.png');
  assert.equal(partial.ids.length, 2, 'only the files that actually landed hand back an id');
});

test('the run budget marks files it never attempted as skipped instead of dropping them', async () => {
  const harness = drive({
    files: 3,
    attemptCostMs: 100,
    options: { maxAttempts: 2, runTimeoutMs: 150, backoffBaseMs: 10 },
    script: (index) => OK(index)
  });
  const result = await harness.run;
  assert.deepEqual(harness.log, ['attempt:0.1@0', 'attempt:1.1@100'], 'the third file is never even tried');
  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.done + result.failed + result.skipped, result.total);
  assert.equal(result.items[2].state, DOWNLOAD_STATE.SKIPPED);
  assert.match(result.items[2].error, /run budget/);
  assert.ok(result.warning, 'a run that abandoned a file must say so');
});

test('progress is reported while the run is in flight, not just at the end', async () => {
  const harness = drive({
    files: 3,
    options: { maxAttempts: 3, backoffBaseMs: 50 },
    script: (index, attempt) => (index === 1 && attempt === 1 ? FAIL('SERVER_FAILED') : OK(index))
  });
  const result = await harness.run;
  const settled = harness.progress.map(p => p.settled);
  assert.ok(harness.progress.length >= 4, `only ${harness.progress.length} progress events`);
  for (let i = 1; i < settled.length; i += 1) {
    assert.ok(settled[i] >= settled[i - 1], 'progress must never go backwards');
  }
  // The assertion that matters: at least three DIFFERENT states were reported, so
  // this cannot be satisfied by a single report at the end of the run.
  assert.ok(new Set(settled).size >= 3, `only ${new Set(settled).size} distinct settled counts were reported`);
  assert.equal(settled[0], 0, 'a run announces itself before the first file lands');
  assert.ok(harness.progress.some(p => p.retrying === 1), 'the retrying state has to be visible while it is happening');
  const last = harness.progress[harness.progress.length - 1];
  assert.equal(last.settled, 3);
  assert.equal(last.ratio, 1);
  assert.equal(last.complete, true);
  assert.equal(result.retries, 1);
});
