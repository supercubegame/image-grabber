// Pure core: what to do when a download fails, how long to wait before trying
// again, and what a run looks like while it is still in flight.
//
// Same rules as images.js and scroll.js - no DOM, no browser APIs, no clock, no
// randomness, no I/O - with one deliberate exception the fast gate cannot see, so
// this comment has to state it loudly:
//
//   runDownloads() takes `start`, `wait` and `now` as ARGUMENTS. It never reaches
//   for them. Same inputs still mean same output; the effects live at the caller.
//
// Why the driver lives here instead of in the service worker: the one thing that
// has to be provable about a backoff is that it was actually AWAITED. A state
// machine that merely returns "wait 500ms next" can be ignored by its caller and no
// assertion would ever notice. With `wait` injected, a test owns the clock and can
// prove the driver suspended between attempts, in order, for growing durations.
// See test/unit/retry.test.js and the injected-clock check in scripts/verify.js.

// The interrupt reasons a download can end with, split by the only question that
// matters here: is trying again worth anything?
//
// DOWNLOAD_TIMEOUT is ours, not the browser's: it is what the caller reports when
// the per-download deadline expires.
const RETRYABLE = new Set([
  'SERVER_FAILED',                  // 5xx - the classic "try again in a moment"
  'SERVER_UNREACHABLE',
  'SERVER_NO_RANGE',                // resume refused; a fresh download can still work
  'SERVER_CONTENT_LENGTH_MISMATCH',
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN',
  'FILE_TRANSIENT_ERROR',
  'FILE_TOO_SHORT',                 // truncated transfer
  'FILE_HASH_MISMATCH',
  'CRASH',
  'DOWNLOAD_TIMEOUT'
]);

// Retrying any of these just burns time, or worse, hammers a server that has
// already given a final answer.
const PERMANENT = new Set([
  'USER_CANCELED',
  'USER_SHUTDOWN',
  'SERVER_BAD_CONTENT',             // 404
  'SERVER_UNAUTHORIZED',
  'SERVER_FORBIDDEN',
  'SERVER_CERT_PROBLEM',
  'SERVER_CROSS_ORIGIN_REDIRECT',
  'NETWORK_INVALID_REQUEST',
  'FILE_FAILED',
  'FILE_ACCESS_DENIED',
  'FILE_NO_SPACE',
  'FILE_NAME_TOO_LONG',
  'FILE_TOO_LARGE',
  'FILE_VIRUS_INFECTED',
  'FILE_BLOCKED',
  'FILE_SECURITY_CHECK_FAILED',
  'FILE_SAME_AS_SOURCE'
]);

export const DOWNLOAD_STATE = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  RETRYING: 'retrying',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped'   // the run budget ran out before this file was ever attempted
});

// The MV3 worker shuts down after roughly this long with nothing happening. Every
// step of a run except a bare sleep produces events that reset that timer, so the
// backoff is the one stretch that has to stay comfortably inside it.
export const WORKER_IDLE_SHUTDOWN_MS = 30000;
export const MAX_SAFE_BACKOFF_MS = 10000;

// These six move as one group. The fast gate checks the relationships; AGENTS.md
// spells out which ones and why.
//
// On backoffMaxMs: a cap only means anything if the schedule can REACH it, i.e. if
// it sits below backoffBaseMs x backoffFactor^(maxAttempts - 2). With 4 attempts,
// 500ms and a factor of 2 the waits would run 500/1000/2000, so 1500 is what makes
// the last one a clipped wait rather than a decorative constant. It sat at 4000
// with 3 attempts for a while and could never fire; the fast gate now proves the
// default schedule is genuinely clipped.
export const DEFAULT_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 4,
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 1500,
  perDownloadTimeoutMs: 12000,
  runTimeoutMs: 300000
});

function numberAtLeast(value, min, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export function mergeRetryOptions(partial) {
  const input = partial && typeof partial === 'object' ? partial : {};
  return {
    maxAttempts: numberAtLeast(input.maxAttempts, 1, DEFAULT_RETRY_OPTIONS.maxAttempts),
    backoffBaseMs: numberAtLeast(input.backoffBaseMs, 0, DEFAULT_RETRY_OPTIONS.backoffBaseMs),
    backoffFactor: numberAtLeast(input.backoffFactor, 1, DEFAULT_RETRY_OPTIONS.backoffFactor),
    backoffMaxMs: numberAtLeast(input.backoffMaxMs, 0, DEFAULT_RETRY_OPTIONS.backoffMaxMs),
    perDownloadTimeoutMs: numberAtLeast(input.perDownloadTimeoutMs, 100, DEFAULT_RETRY_OPTIONS.perDownloadTimeoutMs),
    runTimeoutMs: numberAtLeast(input.runTimeoutMs, 100, DEFAULT_RETRY_OPTIONS.runTimeoutMs)
  };
}

// An unrecognised reason is treated as PERMANENT and reported with its raw code.
// Retrying on reasons nobody has classified is how a downloader ends up hammering a
// server for a reason nobody understands; surfacing the code instead means the next
// person classifies it deliberately.
export function classifyFailure(reason) {
  const code = typeof reason === 'string' && reason.trim() ? reason.trim().toUpperCase() : 'UNKNOWN';
  if (RETRYABLE.has(code)) return { code, retryable: true, known: true };
  if (PERMANENT.has(code)) return { code, retryable: false, known: true };
  return { code, retryable: false, known: false };
}

// No jitter, on purpose: randomness is banned in the core, and a jittered delay
// cannot be asserted to the millisecond either. Jitter belongs here only if
// somebody also injects the generator.
export function backoffFor(failedAttempt, options) {
  const config = mergeRetryOptions(options);
  const exponent = Math.max(0, Math.floor(Number(failedAttempt) || 1) - 1);
  const raw = config.backoffBaseMs * Math.pow(config.backoffFactor, exponent);
  return Math.min(config.backoffMaxMs, Math.round(raw));
}

// One entry per wait the run can perform, i.e. maxAttempts - 1 of them.
export function backoffSchedule(options) {
  const config = mergeRetryOptions(options);
  const waits = [];
  for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) waits.push(backoffFor(attempt, config));
  return waits;
}

// The same schedule with the cap lifted. Only the gate uses it, and only to prove
// the cap is load-bearing: if this comes back identical to backoffSchedule(), the
// cap can never fire and is decoration. Exported rather than recomputed in the gate
// so the growth formula lives in exactly one place.
export function uncappedBackoffSchedule(options) {
  return backoffSchedule({ ...mergeRetryOptions(options), backoffMaxMs: Number.MAX_SAFE_INTEGER });
}

// Worst case for a SINGLE file: every attempt burns its whole deadline and every
// backoff is waited out in full. Coupled to the browser gate's download wait - one
// bad file must not be able to time the gate out instead of failing it.
export function worstCaseItemMs(options) {
  const config = mergeRetryOptions(options);
  const waiting = backoffSchedule(config).reduce((sum, ms) => sum + ms, 0);
  return config.maxAttempts * config.perDownloadTimeoutMs + waiting;
}

function failureMessage(verdict, attempts, config, outOfBudget) {
  const waits = backoffSchedule(config).slice(0, Math.max(0, attempts - 1)).join('+');
  if (outOfBudget) return `${verdict.code}: the ${config.runTimeoutMs}ms run budget ran out after ${attempts} attempt(s)`;
  if (!verdict.known) return `${verdict.code}: unrecognised failure reason, treated as permanent - classify it in src/core/retry.js if it is transient`;
  if (!verdict.retryable) return `${verdict.code}: a final answer, not worth retrying`;
  return `${verdict.code}: still failing after ${attempts} attempts${waits ? ` (waited ${waits}ms in between)` : ''}`;
}

// Drives every download of a run, one file at a time, and reports after every state
// change. `start` does the actual work and returns { ok, id, filename, bytes } or
// { ok: false, reason, detail }; `wait` suspends; `now` reads the clock.
export async function runDownloads({ items, start, wait, now, options, onProgress } = {}) {
  const list = Array.isArray(items) ? items : [];
  const config = mergeRetryOptions(options);
  if (typeof start !== 'function') throw new Error('runDownloads needs a start(record, context) function');
  const clock = typeof now === 'function' ? now : () => 0;
  const sleep = typeof wait === 'function' ? wait : async () => {};
  const startedAt = clock();

  const records = list.map((item, index) => ({
    index,
    url: item && item.url ? item.url : '',
    filename: item && item.filename ? item.filename : '',
    state: DOWNLOAD_STATE.PENDING,
    id: null,
    finalFilename: null,
    bytes: 0,
    attempts: [],
    error: null,
    errorCode: null,
    retryable: null
  }));

  const totals = { done: 0, failed: 0, skipped: 0, retries: 0, attempts: 0 };
  const count = state => records.reduce((sum, r) => sum + (r.state === state ? 1 : 0), 0);

  const progress = () => {
    const settled = totals.done + totals.failed + totals.skipped;
    return {
      total: records.length,
      done: totals.done,
      failed: totals.failed,
      skipped: totals.skipped,
      retries: totals.retries,
      attempts: totals.attempts,
      active: count(DOWNLOAD_STATE.ACTIVE),
      retrying: count(DOWNLOAD_STATE.RETRYING),
      pending: count(DOWNLOAD_STATE.PENDING),
      settled,
      ratio: records.length ? settled / records.length : 1,
      elapsedMs: Math.max(0, clock() - startedAt),
      complete: settled === records.length
    };
  };
  const emit = () => { if (typeof onProgress === 'function') onProgress(progress()); };

  // A run of N with nothing done yet is information too: it is what tells a UI to
  // show up before the first file lands.
  emit();

  for (const record of records) {
    if (clock() - startedAt >= config.runTimeoutMs) {
      record.state = DOWNLOAD_STATE.SKIPPED;
      record.error = `the ${config.runTimeoutMs}ms run budget ran out before this file was attempted`;
      totals.skipped += 1;
      emit();
      continue;
    }

    let attempt = 0;
    while (attempt < config.maxAttempts) {
      attempt += 1;
      let plannedWaitMs = 0;
      let waitedMs = 0;

      if (attempt > 1) {
        plannedWaitMs = backoffFor(attempt - 1, config);
        record.state = DOWNLOAD_STATE.RETRYING;
        emit();
        const before = clock();
        await sleep(plannedWaitMs);
        waitedMs = Math.max(0, clock() - before);
      }

      record.state = DOWNLOAD_STATE.ACTIVE;
      emit();
      const attemptStartedAt = clock();
      let outcome;
      try {
        outcome = await start(record, { attempt, timeoutMs: config.perDownloadTimeoutMs });
      } catch (err) {
        outcome = { ok: false, reason: 'UNKNOWN', detail: err && err.message ? err.message : String(err) };
      }
      const endedAt = clock();
      totals.attempts += 1;

      const ok = Boolean(outcome && outcome.ok);
      const verdict = ok ? { code: 'OK', retryable: false, known: true } : classifyFailure(outcome && outcome.reason);
      record.attempts.push({
        attempt,
        ok,
        plannedWaitMs,
        waitedMs,
        startedAt: attemptStartedAt,
        endedAt,
        elapsedMs: Math.max(0, endedAt - attemptStartedAt),
        reason: ok ? null : verdict.code,
        retryable: ok ? null : verdict.retryable,
        known: ok ? null : verdict.known,
        detail: outcome && outcome.detail ? String(outcome.detail).slice(0, 300) : null
      });

      if (ok) {
        record.state = DOWNLOAD_STATE.DONE;
        record.id = outcome.id === undefined ? null : outcome.id;
        record.finalFilename = outcome.filename || record.filename;
        record.bytes = Number(outcome.bytes) || 0;
        totals.done += 1;
        emit();
        break;
      }

      record.errorCode = verdict.code;
      record.retryable = verdict.retryable;
      const outOfBudget = clock() - startedAt >= config.runTimeoutMs;
      if (verdict.retryable && attempt < config.maxAttempts && !outOfBudget) {
        totals.retries += 1;
        continue;
      }
      record.state = DOWNLOAD_STATE.FAILED;
      record.error = failureMessage(verdict, attempt, config, outOfBudget);
      totals.failed += 1;
      emit();
      break;
    }
  }

  const final = progress();
  // Files must never just disappear. If this ever throws, the accounting is broken
  // and a silent hole is exactly the failure this module exists to prevent - louder
  // is better than a plausible-looking total.
  if (totals.done + totals.failed + totals.skipped !== records.length) {
    throw new Error(`download accounting is broken: ${totals.done} done + ${totals.failed} failed + ${totals.skipped} skipped != ${records.length} requested`);
  }

  const failures = records
    .filter(r => r.state === DOWNLOAD_STATE.FAILED || r.state === DOWNLOAD_STATE.SKIPPED)
    .map(r => ({ url: r.url, filename: r.filename, state: r.state, error: r.error, errorCode: r.errorCode, attempts: r.attempts.length }));

  return {
    total: records.length,
    done: totals.done,
    failed: totals.failed,
    skipped: totals.skipped,
    retries: totals.retries,
    attempts: totals.attempts,
    elapsedMs: final.elapsedMs,
    complete: final.complete && totals.failed === 0 && totals.skipped === 0,
    // Same contract as the scroll summary: exactly one of "everything landed" and
    // "here is what did not" is present. Both or neither means the report lies.
    warning: totals.failed === 0 && totals.skipped === 0
      ? null
      : `${totals.failed + totals.skipped} of ${records.length} file(s) could not be downloaded: ${failures.map(f => `${f.filename || f.url} - ${f.error}`).join('; ')}`,
    bytes: records.reduce((sum, r) => sum + r.bytes, 0),
    ids: records.filter(r => r.state === DOWNLOAD_STATE.DONE && r.id !== null).map(r => r.id),
    failures,
    progress: final,
    items: records.map(r => ({
      url: r.url,
      filename: r.filename,
      finalFilename: r.finalFilename,
      state: r.state,
      id: r.id,
      bytes: r.bytes,
      error: r.error,
      errorCode: r.errorCode,
      retryable: r.retryable,
      attempts: r.attempts.slice()
    }))
  };
}
