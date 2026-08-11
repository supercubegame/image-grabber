// Every number the browser gate asserts, in one place.
//
// These are coupled to the fixture pages - change a fixture and you must recompute
// these. Deriving them at runtime would make the gate agree with whatever the code
// happens to do, which is the opposite of a test.
export const EXPECTED = {
  imgElements: 6,              // <img> tags in gallery.html
  rawCandidates: 8,            // 6 <img> + 2 background images
  uniqueImages: 6,             // 5 distinct http urls + 1 data url
  defaultVisible: 5,           // data: urls are hidden unless asked for
  minWidth200Visible: 3,       // 400x300, 300x200, probed 500x400 background
  minWidth200NoJpgVisible: 2,  // same, minus the .jpg-classified one
  downloadCount: 2,
  secondPageUnique: 2,
  probedBackground: { path: '/img/500x400.png', width: 500, height: 400 },
  // Context menu, default settings: every unique image except the inline data url.
  // No probing happens on this path (a worker has no DOM), which is fine at the
  // default min size of 0 - see AGENTS.md before pairing it with a size filter.
  contextMenuId: 'download-all-images',
  contextMenuScrollId: 'download-all-images-scrolled',
  bulkDownloads: 5,
  bulkSkipped: 1,
  // How many more distinct colours the populated popup shows than the empty one.
  //
  // A delta, deliberately - NOT an absolute floor. There used to be a
  // `minColorsPopulated: 40` here and it was vacuous: the empty popup samples 395
  // colours from its own background, so it passed with the list completely broken.
  // Only the difference between the two screenshots can come from thumbnails.
  //
  // Measured in CI: 395 empty -> 1851 populated, delta 1456. The floor keeps ~3.6x
  // margin; it is here to catch "nothing rendered", not to benchmark the renderer.
  // Add or remove a fixture thumbnail and this moves with defaultVisible.
  minColorDelta: 400,

  // --- auto-scroll -------------------------------------------------------------
  // Coupled to scroll-finite.html / scroll-endless.html / scroll-broken.html AND to
  // the option sets at the top of scripts/verify-e2e.js. Three things move together
  // here: the fixture's batch maths, the counts below, and the scroll limits.
  scroll: {
    // scroll-finite.html: 3 on load + 3 batches of 3.
    finiteInitialImages: 3,
    finiteTotalImages: 12,
    // Rounds in which the image count grew - one per batch. Distinguishes "the page
    // kept feeding us" from "nothing ever arrived", which the totals alone cannot.
    finiteGrowthRounds: 3,

    // scroll-endless.html: 3 on load + 2 per round, forever.
    endlessInitialImages: 3,
    // A floor, not an exact count: how many batches land before the cap depends on
    // CI timing. 6 scrolls x 2 = 12 expected; 7 means at least two batches arrived,
    // which is all this assertion needs to prove the run was doing real work.
    endlessMinImages: 7,

    // scroll-broken.html: 3 on load + exactly one successful batch of 3, then the
    // loader dies. Growth stops after one round and never resumes.
    brokenTotalImages: 6,
    brokenGrowthRounds: 1,

    // The optional cap, exercised against the endless page: 3 + 2 + 2 + 2 = 9 lands
    // exactly on it. Reaching it must end the run through the NORMAL path.
    imageCap: 9,

    // Only here to catch "the timeout never fires". The run is asked to stop at
    // 1500ms; this ceiling has ~10x margin because CI has no GPU and shared CPU.
    timeoutCeilingMs: 15000
  },

  // --- download retries and progress -------------------------------------------
  // Coupled to the retry defaults in src/core/retry.js and to the fixture server's
  // /flaky/ and /once/ routes. The fast gate checks the relationships that matter
  // rather than trusting this comment; see the coupled-parameters block in
  // AGENTS.md before changing any of it.
  downloads: {
    // How long the browser gate waits for downloads to reach a terminal state.
    // Lives here rather than in verify-e2e.js so the FAST gate can check it against
    // worstCaseItemMs(): one bad file must fail the gate, never time it out.
    gateTimeoutMs: 40000,

    // /flaky/2/... 500s twice, then serves the image. This MUST stay strictly below
    // maxAttempts (3) or the retry check would quietly be asserting a give-up.
    flakyFailures: 2,
    flakyAttempts: 3,

    // A wait measured on a real clock can come up a hair short of the value asked
    // for; it cannot come up 10% short. Loose enough for a shared CI runner, tight
    // enough that "did not wait at all" is still a failure.
    backoffToleranceRatio: 0.9,

    // The mixed run the progress checks use: three healthy files plus one flaky one.
    mixedTotal: 4,
    minProgressEvents: 6,
    // Distinct settled counts (0..4). Three of them cannot come from a single report
    // at the end of the run, which is the thing being proven.
    minDistinctProgress: 3,
    minPaintedWidths: 3,

    // downloads.html: 2 images that always work + 1 that works exactly once, so the
    // page renders it and every download attempt gets a 500.
    batchTotal: 3,
    batchDone: 2,
    batchFailed: 1
  }
};
