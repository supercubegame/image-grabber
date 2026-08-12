# Image Grabber — project rules

Chrome MV3 extension. Scans a tab for images (`<img>`, CSS backgrounds, generated
`::before`/`::after`), filters, downloads them through `chrome.downloads` with retries,
progress and optional auto-scroll. Two triggers: the popup and two right-click items.

## Layout

```
manifest.json                     MV3 manifest (extension root = repo root)
src/core/images.js                pure: parse css urls, normalise, filter, plan, name
src/core/scroll.js                pure: the bottom-of-page state machine
src/core/retry.js                 pure: classify failures, backoff, download driver
src/content/collect.js            injected collector, classic + synchronous
src/content/scroll_step.js        injected scroll round: measure, then scroll
src/background/service_worker.js  the only file touching chrome.* side effects
src/popup/                        popup UI, probing, rendering, progress bar
scripts/verify.js                 fast gate (no dependencies, seconds)
scripts/verify-e2e.js             browser gate (headless Chrome, real behaviour)
test/                             unit tests, fixture server + pages, expected.js
```

## Commands

```
npm run verify        # fast gate — run this after EVERY change
npm install && npm run verify:e2e   # browser gate (downloads Chrome)
```

**Iron rule: no change is done until `npm run verify` exits 0.** CI runs both gates
and writes one report comment to the PR (or to the commit when there is no PR). Read
it; it carries the evidence. Each gate tees stdout to `test/artifacts/stdout-*.log`,
which the comment falls back to when a gate dies before writing a report.

## Invariants

1. **`src/core/*.js` stays pure.** No DOM, no `chrome.*`, no clock, no unseeded
   randomness, no I/O; the fast gate greps for these. That is what makes "same input,
   same output" assertable and the logic testable without a browser. The scroll machine
   takes elapsed time as an argument, `runDownloads` takes `start`/`wait`/`now`.
2. **`window.__DIAG__` / `self.__DIAG__` are read-only surfaces for the gate.** Fields
   may be ADDED, never renamed or removed: rename one and the gate goes quiet instead
   of red. `contextMenuScroll` is a sibling of `contextMenu` for that reason.
3. **Injected scripts stay classic and synchronous.** In `collect.js` and
   `scroll_step.js` the last expression is the return value; we never rely on the
   scripting API awaiting a promise. `scroll_step.js` measures, then scrolls - the
   loop and the waiting live in the worker.
4. **The collector reports what it saw; the core decides what it means.** `collect.js`
   returns raw `backgroundImage` strings and an element count, never parsed urls:
   `url()` parsing is `parseCssUrls`, unit tested against real computed styles. The
   regex it replaced (`[^'")]+`) dropped every quoted url with a bracket. A pseudo-
   element counts only when GENERATED - Chrome answers for a `::before` with no `content`.
5. **A scan that did not look at the whole page says so.** `SCAN_ELEMENT_LIMIT` (4000)
   caps the CSS walk; `scanCoverage` turns a partial walk into `complete: false` plus a
   warning, riding out on `scanComplete`/`scanWarning`, the popup banner and the badge
   `?` - same contract as an unconfirmed scroll. A MISSING coverage report also reads as
   incomplete. The cap is on elements - `document.images` is always walked whole.
6. **`?tabId=` is a read-only override** for the gate; the popup defaults to the
   active tab.
7. **Every download path goes through `planDownloads`.** It filters, numbers and
   prefixes `image-grabber/`; `suggestFilename` sanitises (no slashes, no `..`). Two
   triggers building their own paths grow two behaviours.
8. **Both menu items and the `bulk-download` message are one function**
   (`bulkDownload()`). Headless Chrome cannot open a native menu, so the gate drives
   the message and separately asserts each item was accepted and that `onClicked` has
   a listener. Give a click its own copy and the menu is untested.
9. **The bottom of a page is a claim, and only `src/core/scroll.js` may make it.** The
   page has ended when `stableRounds` (3) CONSECUTIVE post-scroll measurements show an
   unchanged `<img>` count AND an unchanged `scrollHeight`.
   - `maxScrolls` and `timeoutMs` are safety nets, not endings: tripping one gives
     `reachedEnd: false`, a `warning` and a `?` on the badge. A run that gave up must
     never read as a clean sweep - that is the whole point of the feature.
   - `maxImages` is the exception: the caller got the N it asked for, so it ends
     through the normal path with `reachedEnd: true` and no warning.
   - `reachedEnd` is derived once, in `isConfirmedEnd`. An unreadable measurement
     throws - reading it as "unchanged" settles any run after three failed injections.
10. **A file is downloaded when it is on disk, and every download goes through
    `runDownloads`.** An id from `chrome.downloads.download` means the transfer
    STARTED; the worker waits for the real terminal state. `done + failed + skipped
    === total` is asserted in the driver - a hole in that sum is a lost file.
    - **A permanent failure is an OUTCOME, not an error.** It never enters
      `__DIAG__.errors`; it rides out on `failed`, the warning, the bar and a `2/3`
      badge. Filing it as an error would turn one dead image into a red zero-errors
      check - same reasoning as an unconfirmed scroll.
    - **An unrecognised interrupt reason is permanent**, reported with its raw code.
      Classify new ones deliberately in `RETRYABLE`/`PERMANENT`.
    - Retries use `conflictAction: 'overwrite'`; only a first attempt uniquifies - a
      retry at a path we chose would otherwise pile up `name (1).png`.

## Behaviour worth knowing before you change it

- **The menu path does not probe.** A worker has no DOM, so images with no intrinsic
  size stay 0x0 there while the popup probes them. Harmless at the default min size of
  0; pair the menu with a min-size filter and those images are skipped.
- **The badge is the menu's only feedback.** `5` means five landed, `5?` means the end
  was never confirmed OR the page was too big to inspect whole, `2/3` means a lost file.
- **Progress is broadcast and nobody may be listening.** With the popup closed it has
  no receiver; the rejection is swallowed on purpose and the badge is the other half.
- **The two triggers fail from different fixtures.** The menu path uses `downloads.html`
  (`/once/` serves the page then 500s forever); flaky and backoff checks go through the
  popup's message path, because an `<img>` that answers 500 logs a console error.
- **A stalled page is indistinguishable from a finished one, and we do not pretend
  otherwise.** A dead loader stops changing, so it reports `settled` with whatever
  arrived (`scroll-broken.html`); only `growthRounds` hints. Any fix guesses at markup.
- **Auto-scroll is off by default:** it moves the user's page and takes seconds.

## Coupled parameters — change one, recheck the other

- `PROBE_TIMEOUT_MS` (popup.js, 4000) ↔ `POLL_TIMEOUT_MS` (verify-e2e.js, 20000).
  Polling must outlast the worst-case probe or scan assertions become flaky timeouts.
- **`MAX_ELEMENTS` (collect.js) ↔ `SCAN_ELEMENT_LIMIT` (core) ↔ `FILLER_COUNT` in
  `many-elements.html` ↔ `EXPECTED.coverage`.** An injected classic script cannot
  import the core, so those two constants are copies and the fast gate compares them.
  The fixture must stay well above the limit or the truncation check quietly passes
  against a complete scan.
- **Every fixture ↔ `test/fixtures/expected.js`.** Each asserted number is
  hand-computed from a fixture; deriving them at runtime makes the test agree with the
  code by construction. Recompute all of it when a fixture changes: `uniqueImages` =
  `bulkDownloads` + `bulkSkipped` at default settings; `minColorDelta` (400) tracks the
  thumbnails `defaultVisible` shows (measured 1463, ~3.6x margin); `scroll-finite`
  needs 3 scrolls + 3 to confirm, so `GATE_SCROLL.maxScrolls` (12) stays > 6.
- **The four scroll parameters move as one group** (`src/core/scroll.js`, 3 / 40 /
  20000 / 400): `settleMs` must exceed the page's lazy-load latency or every round
  looks stable and the run ends early; `maxScrolls × settleMs` must stay under
  `timeoutMs` or the scroll cap can never fire; `timeoutMs` must stay under the MV3
  worker's ~30s idle shutdown or a long run is torn down mid-loop.
- **The six retry parameters move as one group** (`src/core/retry.js`: 4 attempts,
  500ms base, factor 2, 1500ms cap, 12000ms per download, 300000ms run budget, giving
  waits of 500 + 1000 + 1500). Change ONE and recompute ALL of these - the fast gate
  checks every line, so a mistake fails in seconds instead of in production:
  - `backoffSchedule()` has `maxAttempts - 1` entries and must grow until it reaches
    `backoffMaxMs`. Below 3 attempts there is one wait and nothing can show growth.
  - **the cap has to be reachable**: `backoffMaxMs` < `backoffBaseMs ×
    backoffFactor^(maxAttempts - 2)`, or it can never fire. It sat at 4000 against a
    schedule topping out at 1000 and was decoration until a check said so.
  - the longest wait stays under `MAX_SAFE_BACKOFF_MS` (10s): a bare sleep is the one
    stretch of a run that fires no events to hold off the worker's idle shutdown.
  - `worstCaseItemMs()` = `maxAttempts × perDownloadTimeoutMs + Σ backoff` (51000ms)
    stays under `EXPECTED.downloads.gateTimeoutMs` (60000). One doomed file must FAIL
    the browser gate, never time it out - a timeout costs every assertion after it.
    Raise that ceiling rather than shrink a user-facing timeout to fit it.
  - `runTimeoutMs` covers two worst-case files, or normal runs report files `skipped`.
  - `EXPECTED.downloads.flakyFailures` (2) stays strictly BELOW `maxAttempts` and
    `flakyAttempts` = `flakyFailures + 1`; let them meet and the retry check is
    asserting a give-up instead of a recovery.
- `MIN_UNIT_FILES` (8) / `MIN_UNIT_TESTS` (56) ↔ `test/unit/*` (65 tests in 8 files).
  A FLOOR, so the count beside it can drift unnoticed - it had, by one. Re-read it.
- `MAX_RULES_LINES` (200) ↔ this file, and `CLAUDE.md` must stay byte-identical. Both
  are gate conditions; edit one and copy it over the other.
- `REPORT_STEPS` (verify.js) ↔ the `summary` job's step ids and names. See below.

## Gate rules

- Assert real behaviour: the extension loaded, the list rendered, pixels changed,
  files hit the disk. Never assert that a function exists.
- Poll until a condition holds; never `sleep(n)` and hope. Predicates return booleans.
- Every failure carries evidence (expected vs actual, or an output tail): if the
  comment alone cannot get you to the root cause, the report is incomplete.
- Colour/timing thresholds only catch "nothing rendered" and "hung"; keep 3x margin.
- **Prefer a delta over an absolute floor.** A colour floor lived here for a while and
  could never fail: the empty popup already samples ~445 colours of its own chrome.
  Assert the difference between two states - only that part comes from the feature.
- **Ask of every assertion: if this feature were missing, would this fail?** If not it
  is decoration, and a green decoration is worse than a missing check: nobody goes
  looking. Ask it of thresholds too - a bound the code cannot reach is the same hole.
- **A capability check needs its negative twin.** "The `::before` background was found"
  also passes for a collector that hoovers up every computed style, so that same step
  asserts the never-generated `::before` was NOT.
- **A fixture that fails on purpose has to prove it failed.** The server counts
  requests per path (`server.stats()`) and the retry checks assert those counters
  BEFORE concluding anything. Same for truncation: the gate checks `elementsTotal >
  elementLimit` before believing anything about a partial scan.
- **Progress needs at least three DIFFERENT reported states.** One report at the end
  satisfies "progress was reported" and nothing a user cares about. The popup records
  every bar width it painted, so a bar that jumps straight to 100% leaves one entry.
- **A download baseline counts COMPLETED downloads, not download ENTRIES**
  (`completedCount()`). An `interrupted` entry counts towards `search({}).length` but
  never towards `complete`, so after the first check that leaves a failure behind the
  next is unsatisfiable - and it fails as a TIMEOUT, taking later checks with it.
- **A report that does not arrive did not run.** Run #51 was both gates green and not
  one comment anywhere: the report job's `actions/checkout` died on a TLS error (exit
  128) before it could post. That job now clones nothing - it fetches the two scripts
  it needs over the API with `--retry` - and it seeds a fallback `comment.md` from the
  job results BEFORE any step that can fail, so the degraded path is walked every run
  instead of rotting unused. A degraded comment says so and the job ends red.
- **The report job is shared with `supercubegame/jumpwow`: same steps, same `id:`s,
  same Chinese names.** The gate locates those steps BY ID. An assertion keyed on a
  display label turns "rename a step" into "break the gate", which is how the names
  ended up English here and Chinese there. Names are asserted separately, so a rename
  goes red instead of quietly diverging. What NEITHER repo can assert is that the two
  still match - only a reusable workflow would make them literally one file.
- **New behaviour ships with a new assertion.** A feature the gate cannot see is one
  the next change can break for free.

## Things an agent cannot do here

Publishing to the Chrome Web Store, anything needing a signed-in Chrome profile,
right-clicking a real page to check the menu items read well, running the grabber on a
real infinite-scroll site or flaky network, judging whether the UI is pleasant.
