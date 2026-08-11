// Pure core: the "are we at the bottom yet?" decision, and nothing else.
//
// Same rules as images.js - no DOM, no chrome APIs, no clock, no randomness, no
// I/O. Elapsed time is passed IN as a number so the whole state machine stays a
// function of its inputs; the service worker owns the clock and the waiting.
//
// The criterion (see AGENTS.md, it is a project invariant):
//   the page is at the bottom when `stableRounds` CONSECUTIVE measurements taken
//   after a scroll show an unchanged <img> count AND an unchanged scrollHeight.
// Everything else - scroll cap, total timeout - is a safety net, and tripping a
// safety net is NOT reaching the bottom. That distinction is the whole point of
// this module: a run that gave up must never be reported as a clean sweep.

export const SCROLL_OUTCOME = Object.freeze({
  SETTLED: 'settled',        // the criterion above held - the end is confirmed
  IMAGE_CAP: 'image-cap',    // the caller asked for N images and got them - normal stop
  MAX_SCROLLS: 'max-scrolls', // safety net - end NOT confirmed
  TIMEOUT: 'timeout'         // safety net - end NOT confirmed
});

// Only these two mean "we know what the page had to offer". Keep this list as the
// single source of truth: deriving reachedEnd anywhere else is how the two answers
// drift apart and an aborted run starts looking successful.
const CONFIRMED_OUTCOMES = Object.freeze([SCROLL_OUTCOME.SETTLED, SCROLL_OUTCOME.IMAGE_CAP]);

export function isConfirmedEnd(outcome) {
  return CONFIRMED_OUTCOMES.includes(outcome);
}

// maxScrolls * settleMs must stay below timeoutMs, and timeoutMs below the MV3
// worker's idle shutdown. See the coupled-parameters block in AGENTS.md.
export const DEFAULT_SCROLL_OPTIONS = Object.freeze({
  enabled: false,
  stableRounds: 3,
  maxScrolls: 40,
  timeoutMs: 20000,
  settleMs: 400,
  maxImages: 0 // 0 = no cap
});

function intAtLeast(value, min, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export function mergeScrollOptions(partial) {
  const input = partial && typeof partial === 'object' ? partial : {};
  return {
    enabled: input.enabled === true,
    stableRounds: intAtLeast(input.stableRounds, 1, DEFAULT_SCROLL_OPTIONS.stableRounds),
    maxScrolls: intAtLeast(input.maxScrolls, 1, DEFAULT_SCROLL_OPTIONS.maxScrolls),
    timeoutMs: intAtLeast(input.timeoutMs, 100, DEFAULT_SCROLL_OPTIONS.timeoutMs),
    settleMs: intAtLeast(input.settleMs, 0, DEFAULT_SCROLL_OPTIONS.settleMs),
    maxImages: intAtLeast(input.maxImages, 0, DEFAULT_SCROLL_OPTIONS.maxImages)
  };
}

export function initScrollRun(options) {
  return Object.freeze({
    options: mergeScrollOptions(options),
    rounds: 0,
    scrolls: 0,
    stable: 0,
    growthRounds: 0,
    firstImages: null,
    images: 0,
    height: 0,
    elapsedMs: 0,
    done: false,
    outcome: null,
    reachedEnd: false,
    history: []
  });
}

// A measurement that cannot be read must throw, not quietly compare as "unchanged".
// Silently treating a broken injection as stability would settle every run on the
// first three failures - the exact false green this module exists to prevent.
function readMeasurement(measurement) {
  const input = measurement && typeof measurement === 'object' ? measurement : null;
  if (!input) throw new Error('scroll measurement is missing');
  const images = Number(input.imageCount);
  const height = Number(input.scrollHeight);
  if (!Number.isFinite(images) || !Number.isFinite(height)) {
    throw new Error(`scroll measurement is not numeric: imageCount=${input.imageCount}, scrollHeight=${input.scrollHeight}`);
  }
  return { images: Math.floor(images), height: Math.floor(height) };
}

// One round = one measurement plus the scroll that follows it. The first round is
// the baseline (nothing has been scrolled yet), so `scrolls` is always rounds - 1
// and stability can only start counting from the second round.
export function observeScroll(state, measurement, elapsedMs) {
  if (!state || state.done) return state;
  const value = readMeasurement(measurement);
  const config = state.options;
  const rounds = state.rounds + 1;
  const scrolls = rounds - 1;
  const hasPrevious = state.rounds > 0;
  const unchanged = hasPrevious && value.images === state.images && value.height === state.height;
  const stable = unchanged ? state.stable + 1 : 0;
  const grew = hasPrevious && value.images > state.images;
  const parsedElapsed = Number(elapsedMs);
  const elapsed = Number.isFinite(parsedElapsed) ? Math.max(0, Math.floor(parsedElapsed)) : state.elapsedMs;

  // Order matters. A normal stop wins over a safety net that trips in the same
  // round, and a confirmed bottom wins over a timeout: we did see the end.
  let outcome = null;
  if (config.maxImages > 0 && value.images >= config.maxImages) outcome = SCROLL_OUTCOME.IMAGE_CAP;
  else if (stable >= config.stableRounds) outcome = SCROLL_OUTCOME.SETTLED;
  else if (elapsed >= config.timeoutMs) outcome = SCROLL_OUTCOME.TIMEOUT;
  else if (scrolls >= config.maxScrolls) outcome = SCROLL_OUTCOME.MAX_SCROLLS;

  return Object.freeze({
    options: config,
    rounds,
    scrolls,
    stable,
    growthRounds: grew ? state.growthRounds + 1 : state.growthRounds,
    firstImages: state.firstImages === null ? value.images : state.firstImages,
    images: value.images,
    height: value.height,
    elapsedMs: elapsed,
    done: outcome !== null,
    outcome,
    reachedEnd: isConfirmedEnd(outcome),
    history: state.history.concat([{ round: rounds, images: value.images, height: value.height, stable, elapsedMs: elapsed }]).slice(-60)
  });
}

function warningFor(state) {
  if (state.reachedEnd) return null;
  const limits = state.options;
  if (!state.done) return 'end of page NOT confirmed: the scroll run never reached a verdict';
  if (state.outcome === SCROLL_OUTCOME.TIMEOUT) {
    return `end of page NOT confirmed: gave up after ${state.elapsedMs}ms (timeout ${limits.timeoutMs}ms), ${state.images} images seen so far`;
  }
  return `end of page NOT confirmed: gave up after ${state.scrolls} scrolls (cap ${limits.maxScrolls}), ${state.images} images seen so far`;
}

// The shape every caller reports to the user. `reachedEnd` and `warning` always
// disagree in exactly one direction: no warning means the end was confirmed.
export function scrollSummary(state) {
  const limits = state.options;
  return {
    outcome: state.outcome,
    reachedEnd: state.reachedEnd,
    rounds: state.rounds,
    scrolls: state.scrolls,
    stableRounds: state.stable,
    growthRounds: state.growthRounds,
    imagesAtStart: state.firstImages === null ? 0 : state.firstImages,
    imagesAtEnd: state.images,
    heightAtEnd: state.height,
    elapsedMs: state.elapsedMs,
    limits: {
      stableRounds: limits.stableRounds,
      maxScrolls: limits.maxScrolls,
      timeoutMs: limits.timeoutMs,
      settleMs: limits.settleMs,
      maxImages: limits.maxImages
    },
    warning: warningFor(state)
  };
}
