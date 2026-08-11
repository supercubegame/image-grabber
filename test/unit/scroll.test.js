import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCROLL_OPTIONS,
  SCROLL_OUTCOME,
  mergeScrollOptions,
  initScrollRun,
  observeScroll,
  scrollSummary,
  isConfirmedEnd
} from '../../src/core/scroll.js';

// Every test drives the state machine the way the worker does: one measurement per
// round, elapsed time supplied from outside. `step` is the pretend cost of a round.
const still = (count, images = 12, height = 4800) =>
  new Array(count).fill(0).map(() => ({ imageCount: images, scrollHeight: height }));
const growing = count =>
  new Array(count).fill(0).map((_, i) => ({ imageCount: 12 + i * 2, scrollHeight: 4800 + i * 800 }));

function drive(options, measurements, step = 100) {
  let run = initScrollRun({ enabled: true, ...options });
  let elapsed = 0;
  for (const measurement of measurements) {
    elapsed += step;
    run = observeScroll(run, measurement, elapsed);
    if (run.done) break;
  }
  return run;
}

const ROOMY = { stableRounds: 3, maxScrolls: 50, timeoutMs: 60000 };

test('missing or junk options fall back to the defaults', () => {
  assert.deepEqual(mergeScrollOptions(null), { ...DEFAULT_SCROLL_OPTIONS });
  assert.deepEqual(mergeScrollOptions('nonsense'), { ...DEFAULT_SCROLL_OPTIONS });
  assert.equal(mergeScrollOptions({ stableRounds: 'three' }).stableRounds, DEFAULT_SCROLL_OPTIONS.stableRounds);
  assert.equal(mergeScrollOptions({}).enabled, false);
});

test('limits are clamped to values that can actually terminate a run', () => {
  assert.equal(mergeScrollOptions({ stableRounds: 0 }).stableRounds, 1);
  assert.equal(mergeScrollOptions({ maxScrolls: -4 }).maxScrolls, 1);
  assert.equal(mergeScrollOptions({ timeoutMs: 5 }).timeoutMs, 100);
  assert.equal(mergeScrollOptions({ settleMs: -1 }).settleMs, 0);
  assert.equal(mergeScrollOptions({ maxImages: -9 }).maxImages, 0);
  assert.equal(mergeScrollOptions({ maxImages: 25.9 }).maxImages, 25);
});

test('a single measurement is never a verdict', () => {
  // The first round is the baseline: nothing has been scrolled yet, so "unchanged"
  // is not a statement about anything.
  const run = drive(ROOMY, still(1));
  assert.equal(run.done, false);
  assert.equal(run.outcome, null);
  assert.equal(run.scrolls, 0);
});

test('two unchanged rounds are one short of the N=3 criterion', () => {
  // Guards the off-by-one directly: if stability counted the baseline, this run
  // would already be settled and every page would end two scrolls too early.
  const run = drive(ROOMY, still(3));
  assert.equal(run.stable, 2);
  assert.equal(run.done, false);
  assert.equal(run.reachedEnd, false);
});

test('three unchanged rounds after the baseline confirm the bottom', () => {
  const run = drive(ROOMY, still(4));
  assert.equal(run.outcome, SCROLL_OUTCOME.SETTLED);
  assert.equal(run.reachedEnd, true);
  assert.equal(run.stable, 3);
  assert.equal(run.scrolls, 3);
});

test('any change resets the run of unchanged rounds', () => {
  const feed = [...still(2), ...still(4, 18, 7200)];
  const run = drive(ROOMY, feed);
  assert.equal(run.outcome, SCROLL_OUTCOME.SETTLED);
  // Settling on round 6 instead of round 4 is the proof the counter went back to
  // zero when the page grew.
  assert.equal(run.rounds, 6);
  assert.equal(run.growthRounds, 1);
});

test('a page that keeps growing trips the scroll cap and is NOT a confirmed end', () => {
  const run = drive({ ...ROOMY, maxScrolls: 6 }, growing(30));
  assert.equal(run.outcome, SCROLL_OUTCOME.MAX_SCROLLS);
  assert.equal(run.reachedEnd, false);
  assert.equal(run.scrolls, 6);
});

test('a page that keeps growing trips the total timeout and is NOT a confirmed end', () => {
  const run = drive({ ...ROOMY, timeoutMs: 250 }, growing(30));
  assert.equal(run.outcome, SCROLL_OUTCOME.TIMEOUT);
  assert.equal(run.reachedEnd, false);
  assert.ok(run.elapsedMs >= 250, `elapsed ${run.elapsedMs} should have reached the 250ms timeout`);
});

test('the optional image cap ends the run through the normal path', () => {
  const run = drive({ ...ROOMY, maxImages: 16 }, growing(30));
  assert.equal(run.outcome, SCROLL_OUTCOME.IMAGE_CAP);
  assert.equal(run.reachedEnd, true);
  // It stopped because it had enough, not because anything settled or ran out.
  assert.equal(run.stable, 0);
  assert.ok(run.scrolls < 6, `stopped after ${run.scrolls} scrolls, far short of the cap`);
});

test('reachedEnd and the warning always disagree, in every outcome', () => {
  const runs = [
    drive(ROOMY, still(4)),
    drive({ ...ROOMY, maxImages: 16 }, growing(30)),
    drive({ ...ROOMY, maxScrolls: 4 }, growing(30)),
    drive({ ...ROOMY, timeoutMs: 250 }, growing(30))
  ];
  for (const run of runs) {
    const summary = scrollSummary(run);
    const warned = typeof summary.warning === 'string' && summary.warning.length > 0;
    assert.notEqual(warned, summary.reachedEnd, `outcome ${summary.outcome} reports reachedEnd=${summary.reachedEnd} with warning=${summary.warning}`);
    if (warned) assert.match(summary.warning, /NOT confirmed/);
  }
  assert.equal(isConfirmedEnd('who-knows'), false);
  assert.equal(isConfirmedEnd(null), false);
});

test('observing never mutates the state it was handed, and repeats identically', () => {
  const first = initScrollRun({ enabled: true, ...ROOMY });
  const snapshot = JSON.stringify(first);
  const second = observeScroll(first, { imageCount: 5, scrollHeight: 900 }, 100);
  assert.equal(JSON.stringify(first), snapshot);
  assert.notEqual(second, first);
  assert.deepEqual(scrollSummary(drive(ROOMY, still(4))), scrollSummary(drive(ROOMY, still(4))));
  // A finished run is finished: late measurements cannot revive it.
  const done = drive(ROOMY, still(4));
  assert.equal(observeScroll(done, { imageCount: 99, scrollHeight: 1 }, 5000), done);
});

test('an unreadable measurement throws instead of counting as stability', () => {
  // Three failed injections in a row would otherwise look exactly like a page that
  // has stopped growing, and the run would report a confirmed end it never saw.
  const run = initScrollRun({ enabled: true, ...ROOMY });
  assert.throws(() => observeScroll(run, { imageCount: 'lots', scrollHeight: 10 }, 100), /not numeric/);
  assert.throws(() => observeScroll(run, null, 100), /measurement is missing/);
});
