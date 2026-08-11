# Image Grabber — project rules

Chrome MV3 extension. Scans a tab for images, filters them by size and format,
downloads them through `chrome.downloads`. Optionally auto-scrolls a lazy page
first so the scan sees everything the page will ever load. Two triggers: the popup
(pick and choose) and page right-click menu items (grab the whole page in one
click, with or without scrolling).

## Layout

```
manifest.json                 MV3 manifest (extension root = repo root)
src/core/images.js            pure logic: normalise, dedupe, filter, plan, name files
src/core/scroll.js            pure logic: the bottom-of-page state machine
src/content/collect.js        injected collector, classic + synchronous
src/content/scroll_step.js    injected scroll round: measure, then scroll
src/background/service_worker.js  the only place touching chrome.scripting/downloads/contextMenus
src/popup/                    popup UI, probing, rendering
scripts/verify.js             fast gate (no dependencies, seconds)
scripts/verify-e2e.js         browser gate (headless Chrome, real behaviour)
scripts/compose-report.js     merges gate reports into the CI comment
test/unit/                    node:test unit tests for src/core
test/fixtures/                fixture server + gallery pages + expected numbers
test/fixtures/scroll-*.html   lazy pages: one that ends, one that never does, one that breaks
```

## Commands

```
npm run verify        # fast gate — run this after EVERY change
npm install && npm run verify:e2e   # browser gate (downloads Chrome)
```

**Iron rule: no change is done until `npm run verify` exits 0.** CI runs both gates
and writes a single report comment back to the PR (or to the commit when there is
no PR). Read that comment; it carries the evidence.

## Invariants

1. **`src/core/*.js` stays pure.** No DOM, no `chrome.*`, no `Date.now()`, no
   unseeded randomness, no I/O. The fast gate greps for these and fails. Purity is
   what makes "same input, same output" assertable and lets the logic be unit tested
   without a browser. The scroll state machine takes elapsed time as an argument for
   exactly this reason - the worker owns the clock.
2. **`window.__DIAG__` (popup) and `self.__DIAG__` (service worker) are read-only
   diagnostic surfaces for the gate.** Fields may be ADDED, never renamed or removed.
   Rename one and the gate goes quiet instead of red. `contextMenuScroll` is a
   sibling of `contextMenu` rather than an array for this reason.
3. **Injected scripts stay classic and synchronous.** Both `collect.js` and
   `scroll_step.js`: the last expression is the injection's return value and we do
   not depend on the scripting API awaiting a promise. `scroll_step.js` measures
   first and scrolls second; the loop and the waiting live in the worker.
4. **The popup's `?tabId=` query param is a read-only override** used by the gate. The
   popup still defaults to the active tab.
5. **Every download path goes through `planDownloads` in the core.** It applies the
   saved filters, numbers the files and prefixes `image-grabber/`; `suggestFilename`
   does the sanitising (no slashes, no `..`). Neither the popup nor the menu builds a
   path on its own - that is how two triggers quietly grow two behaviours.
6. **Both context menu items and the `bulk-download` message are one function**
   (`bulkDownload()` in the service worker). Headless Chrome cannot open a native
   context menu, so the gate drives the message and separately asserts that each menu
   item was accepted by Chrome and that `onClicked` has a listener. Give a click its
   own copy of the logic and the menu stops being covered by anything.
7. **The bottom of a page is a claim, and only one thing may make it.** The page is
   at the bottom when `stableRounds` (3) CONSECUTIVE measurements taken after a
   scroll show an unchanged `<img>` count AND an unchanged `scrollHeight`. That is
   the criterion; it lives in `src/core/scroll.js` and nowhere else.
   - `maxScrolls` and `timeoutMs` are safety nets, not endings. Tripping either one
     produces `reachedEnd: false`, a `warning`, and a badge with a `?` on it. A run
     that gave up must never be reported as a clean sweep - that is the entire point
     of the feature and the thing to check first if you touch this module.
   - `maxImages` is the exception: the caller asked for N images and got them, so it
     ends through the normal path with `reachedEnd: true` and no warning.
   - `reachedEnd` is derived from the outcome in one place (`isConfirmedEnd`). Do not
     recompute it anywhere else; two derivations will disagree eventually and the
     optimistic one is the one users will see.
   - A measurement that cannot be read throws. Treating a failed injection as
     "unchanged" would settle any run after three failures.

## Behaviour worth knowing before you change it

- **The menu path does not probe.** A worker has no DOM, so images with no intrinsic
  size stay 0x0 there while the popup probes them to real dimensions. Harmless at the
  default min size of 0; pair the menu with a min-size filter and those images are
  skipped. Do not "fix" this by importing a DOM into the worker - fetch + decode in
  the core would be the honest fix, and it needs its own assertions.
- **The toolbar badge is the menu's only feedback.** It shows how many files the last
  bulk run queued, with a trailing `?` when the end of the page was never confirmed.
- **A stalled page is indistinguishable from a finished one, and we do not pretend
  otherwise.** A page whose loader dies while showing a spinner stops changing, so it
  reports `settled` with whatever arrived - see `scroll-broken.html`, which asserts
  exactly that. Only `growthRounds` hints at the difference. Any "fix" here means
  guessing at spinner markup; do not add one without a fixture that proves it beats
  the guess. A page that keeps growing without producing images is the case we DO
  catch: height keeps changing, so it never settles and trips a safety net instead.
- **Auto-scroll is off by default.** It moves the user's page and takes seconds.

## Coupled parameters — change one, recheck the other

- `PROBE_TIMEOUT_MS` (src/popup/popup.js, 4000) ↔ `POLL_TIMEOUT_MS`
  (scripts/verify-e2e.js, 20000). Polling must outlast the worst-case probe, with
  margin, or scan assertions turn into flaky timeouts.
- `test/fixtures/gallery.html` ↔ `test/fixtures/expected.js`. Every count the browser
  gate asserts is hand-computed from the fixture. Edit the fixture, recompute the
  numbers. Never derive them at runtime - a test that agrees with the code by
  construction tests nothing.
- `EXPECTED.uniqueImages` ↔ `EXPECTED.bulkDownloads` + `EXPECTED.bulkSkipped`. The menu
  path takes every unique image except the ones the stored filters drop, so
  `bulkDownloads + bulkSkipped === uniqueImages` at default settings. Add an image to
  the fixture and all three move.
- `EXPECTED.minColorDelta` (400) ↔ the number of fixture thumbnails. Measured delta is
  1456 (395 empty -> 1851 populated); the floor keeps ~3.6x margin. Change how many
  images the popup shows by default and re-measure.
- **The four scroll parameters move as one group** (`src/core/scroll.js`):
  `settleMs` must exceed the page's lazy-load latency or every round looks stable and
  the run ends early; `maxScrolls × settleMs` must stay under `timeoutMs` or the
  scroll cap can never fire; and `timeoutMs` must stay under the MV3 worker's ~30s
  idle shutdown or a long run gets torn down mid-loop. Defaults: 400 / 40 / 20000,
  which spends at most ~18s. Change any one and recheck the other three.
- `scroll-finite.html` batch maths ↔ `GATE_SCROLL.maxScrolls` (scripts/verify-e2e.js,
  12) ↔ `EXPECTED.scroll.*`. The finite fixture needs 3 scrolls to load its batches
  plus 3 more to confirm the end; the cap has to stay above that or the test fails
  for hitting a limit it was never about. Add a batch and all three move.
- `MIN_UNIT_FILES` (6) / `MIN_UNIT_TESTS` (32) in scripts/verify.js ↔ `test/unit/*`
  (36 tests in 6 files today). They exist so a runner that finds no tests fails
  loudly instead of exiting 0. Add tests, raise the floor.

## Gate rules

- Assert real behaviour: the extension loaded, the list rendered, pixels changed,
  files hit the disk. Never assert that a function exists.
- Poll until a condition holds; never `sleep(n)` and hope. Predicates return booleans.
- Every failure must carry evidence (expected vs actual, or output tail). If the
  posted comment alone cannot get you to the root cause, the report is incomplete.
- Colour and timing thresholds only catch "nothing rendered" / "hung". Keep at least
  3x margin; CI has no GPU and shared CPU.
- **Prefer a delta over an absolute floor.** An absolute colour floor lived here for a
  while and could never fail: the empty popup already samples ~395 colours of its own
  chrome, so it passed with the list completely broken. Assert the difference between
  two states - that part can only come from the feature.
- **Ask it of every new assertion: if this feature were missing, would this fail?** If
  not, it is not an assertion, it is decoration - and a green decoration is worse than
  a missing check, because nobody goes looking for it.
- **A fixture that can pass by accident needs its own assertion.** The broken-loader
  check asserts the fixture actually failed before asserting what the grabber did with
  it; otherwise a fixture that quietly finished would produce identical numbers.
- When a critical step fails, later steps are skipped rather than reported as broken.
- **New behaviour ships with a new assertion.** A feature the gate cannot see is a
  feature the next change can break for free.

## Things an agent cannot do here

Publishing to the Chrome Web Store, anything needing a signed-in Chrome profile,
right-clicking a real page to confirm the menu items read well, running the grabber
against a real infinite-scroll site, and judging whether the UI is pleasant to use.
Those are the human's.
