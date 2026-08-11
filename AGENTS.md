# Image Grabber — project rules

Chrome MV3 extension. Scans a tab for images, filters by size and format, downloads
them through `chrome.downloads`, retrying transient failures and reporting progress.
Optionally auto-scrolls a lazy page first so the scan sees everything it will load.
Two triggers: the popup (pick and choose) and two right-click menu items (whole page
in one click, with or without scrolling).

## Layout

```
manifest.json                     MV3 manifest (extension root = repo root)
src/core/images.js                pure: normalise, dedupe, filter, plan, name files
src/core/scroll.js                pure: the bottom-of-page state machine
src/core/retry.js                 pure: classify failures, backoff, download driver
src/content/collect.js            injected collector, classic + synchronous
src/content/scroll_step.js        injected scroll round: measure, then scroll
src/background/service_worker.js  the only file touching chrome.* side effects
src/popup/                        popup UI, probing, rendering, progress bar
scripts/verify.js                 fast gate (no dependencies, seconds)
scripts/verify-e2e.js             browser gate (headless Chrome, real behaviour)
scripts/compose-report.js         merges gate reports into the CI comment
test/unit/                        node:test unit tests for src/core
test/fixtures/                    fixture server, pages, and expected.js
```

## Commands

```
npm run verify        # fast gate — run this after EVERY change
npm install && npm run verify:e2e   # browser gate (downloads Chrome)
```

**Iron rule: no change is done until `npm run verify` exits 0.** CI runs both gates
and writes one report comment to the PR (or to the commit when there is no PR). Read
it; it carries the evidence. Each gate tees stdout to
`test/artifacts/stdout-<slug>.log`, which the comment falls back to when a gate dies
before writing a report.

## Invariants

1. **`src/core/*.js` stays pure.** No DOM, no `chrome.*`, no clock, no unseeded
   randomness, no I/O; the fast gate greps for these. That is what makes "same input,
   same output" assertable and the logic unit-testable without a browser. The scroll
   machine takes elapsed time as an argument and `runDownloads` takes `start`, `wait`
   and `now` - injected effects are what make "the backoff was awaited" provable.
2. **`window.__DIAG__` / `self.__DIAG__` are read-only surfaces for the gate.** Fields
   may be ADDED, never renamed or removed: rename one and the gate goes quiet instead
   of red. `contextMenuScroll` is a sibling of `contextMenu` for that reason.
3. **Injected scripts stay classic and synchronous.** In `collect.js` and
   `scroll_step.js` the last expression is the return value; we never rely on the
   scripting API awaiting a promise. `scroll_step.js` measures, then scrolls - the
   loop and the waiting live in the worker.
4. **The popup's `?tabId=` param is a read-only override** for the gate; the popup
   still defaults to the active tab.
5. **Every download path goes through `planDownloads`.** It applies the filters,
   numbers the files and prefixes `image-grabber/`; `suggestFilename` sanitises (no
   slashes, no `..`). Two triggers building their own paths is how they grow two
   behaviours.
6. **Both menu items and the `bulk-download` message are one function**
   (`bulkDownload()`). Headless Chrome cannot open a native context menu, so the gate
   drives the message and separately asserts each item was accepted and that
   `onClicked` has a listener. Give a click its own copy and the menu is untested.
7. **The bottom of a page is a claim, and only `src/core/scroll.js` may make it.** The
   page has ended when `stableRounds` (3) CONSECUTIVE post-scroll measurements show an
   unchanged `<img>` count AND an unchanged `scrollHeight`.
   - `maxScrolls` and `timeoutMs` are safety nets, not endings: tripping one gives
     `reachedEnd: false`, a `warning` and a `?` on the badge. A run that gave up must
     never read as a clean sweep - that is the whole point of the feature.
   - `maxImages` is the exception: the caller got the N it asked for, so it ends
     through the normal path with `reachedEnd: true` and no warning.
   - `reachedEnd` is derived once, in `isConfirmedEnd`. Two derivations will disagree
     eventually and the optimistic one is what users see.
   - An unreadable measurement throws. Treating a failed injection as "unchanged"
     would settle any run after three failures.
8. **A file is downloaded when it is on disk, and every download goes through
   `runDownloads`.** An id from `chrome.downloads.download` means the transfer
   STARTED; the worker waits for the real terminal state. `done + failed + skipped ===
   total` is asserted inside the driver - a hole in that sum is a file the user never
   got and never heard about.
   - **A permanent failure is an OUTCOME, not an error.** It never enters
     `__DIAG__.errors`; it rides out on `failed`, the warning, the bar and a `2/3`
     badge. Filing it as an error would turn one dead image into a red zero-errors
     check - same reasoning as an unconfirmed scroll.
   - **An unrecognised interrupt reason is permanent** and is reported with its raw
     code. Classify new ones deliberately in `RETRYABLE`/`PERMANENT`.
   - Retries use `conflictAction: 'overwrite'`; only a first attempt uniquifies. A
     retry is a second try at a path we chose, and uniquifying it would pile up
     `name (1).png` and break the generated-name contract.

## Behaviour worth knowing before you change it

- **The menu path does not probe.** A worker has no DOM, so images with no intrinsic
  size stay 0x0 there while the popup probes them. Harmless at the default min size of
  0; pair the menu with a min-size filter and those images are skipped. The honest fix
  is fetch + decode in the core, and it needs its own assertions.
- **The badge is the menu's only feedback.** `5` means five landed, `5?` means the end
  of the page was never confirmed, `2/3` means one file was lost.
- **Progress is broadcast and nobody may be listening.** With the popup closed the
  `download-progress` message has no receiver and the rejection is swallowed on
  purpose; the badge is the other half of the feature for that case.
- **The two triggers get their download failures from different fixtures.** The menu
  path uses `downloads.html`, whose third image is served by `/once/` - it works for
  the page and 500s forever after, so the page renders cleanly while every download
  attempt fails. Flaky/backoff assertions go through the popup's message path instead,
  because a page whose `<img>` answers 500 logs a console error and the zero-errors
  check would fail for an unrelated reason.
- **A stalled page is indistinguishable from a finished one, and we do not pretend
  otherwise.** A loader that dies while showing a spinner stops changing, so it reports
  `settled` with whatever arrived (`scroll-broken.html` asserts exactly that); only
  `growthRounds` hints at the difference. Any fix means guessing at spinner markup - do
  not add one without a fixture that proves it beats the guess. A page that keeps
  growing without producing images IS caught: height keeps changing, so it never
  settles and trips a safety net.
- **Auto-scroll is off by default.** It moves the user's page and takes seconds.

## Coupled parameters — change one, recheck the other

- `PROBE_TIMEOUT_MS` (popup.js, 4000) ↔ `POLL_TIMEOUT_MS` (verify-e2e.js, 20000).
  Polling must outlast the worst-case probe or scan assertions become flaky timeouts.
- **Every fixture ↔ `test/fixtures/expected.js`.** Each asserted number is
  hand-computed from a fixture; deriving them at runtime makes the test agree with the
  code by construction. Edit a fixture and recompute all of it: `uniqueImages` =
  `bulkDownloads` + `bulkSkipped` at default settings; `minColorDelta` (400) tracks the
  thumbnails `defaultVisible` shows, measured 1463 with ~3.6x margin; and
  `scroll-finite.html`'s batch maths ↔ `GATE_SCROLL.maxScrolls` (12) ↔
  `EXPECTED.scroll.*`, where the fixture needs 3 scrolls to load plus 3 to confirm the
  end, so the cap must stay well above 6.
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
  - the longest wait stays under `MAX_SAFE_BACKOFF_MS` (10s), a third of the worker's
    idle shutdown. Every other step of a run fires events that reset that timer; a
    bare sleep is the one stretch that does not.
  - `worstCaseItemMs()` = `maxAttempts × perDownloadTimeoutMs + Σ backoff` (51000ms)
    must stay under `EXPECTED.downloads.gateTimeoutMs` (60000). One file that keeps
    failing has to FAIL the browser gate, never time it out - a timeout there costs
    every assertion after it. Raise that ceiling rather than shrinking a user-facing
    timeout to fit it.
  - `runTimeoutMs` covers at least two worst-case files, or ordinary runs start
    reporting files as `skipped`.
  - `EXPECTED.downloads.flakyFailures` (2) stays strictly BELOW `maxAttempts`, and
    `flakyAttempts` = `flakyFailures + 1`. Let them meet and the browser gate's retry
    check is asserting a give-up instead of a recovery.
- `MIN_UNIT_FILES` (7) / `MIN_UNIT_TESTS` (42) ↔ `test/unit/*` (48 tests in 7 files).
  They exist so a runner that finds nothing fails loudly instead of exiting 0.
- `MAX_RULES_LINES` (200) ↔ this file, and `CLAUDE.md` must stay byte-identical. Both
  are gate conditions; edit one and copy it over the other.

## Gate rules

- Assert real behaviour: the extension loaded, the list rendered, pixels changed,
  files hit the disk. Never assert that a function exists.
- Poll until a condition holds; never `sleep(n)` and hope. Predicates return booleans.
- Every failure carries evidence (expected vs actual, or an output tail). If the
  comment alone cannot get you to the root cause, the report is incomplete.
- Colour and timing thresholds only catch "nothing rendered" and "hung". Keep 3x
  margin; CI has no GPU and a shared CPU.
- **Prefer a delta over an absolute floor.** A colour floor lived here for a while and
  could never fail: the empty popup already samples ~445 colours of its own chrome.
  Assert the difference between two states - only that part comes from the feature.
- **Ask of every assertion: if this feature were missing, would this fail?** If not it
  is decoration, and a green decoration is worse than a missing check because nobody
  goes looking for it. Ask it of every THRESHOLD too: a bound the code can never reach
  (the 4000ms backoff cap) is the same hole wearing a different hat.
- **A fixture that fails on purpose has to prove it failed.** The fixture server counts
  requests per path (`server.stats()`, `server.reset()`) and the retry checks assert
  those counters BEFORE concluding anything: a retry test against a server that never
  failed passes identically.
- **Progress needs at least three DIFFERENT reported states.** One report at the end
  satisfies "progress was reported" and nothing a user cares about. The popup records
  every bar width it painted, so a bar that jumps straight to 100% leaves one entry.
- **A download baseline counts COMPLETED downloads, not download ENTRIES**
  (`completedCount()`). An `interrupted` entry counts towards `search({}).length` but
  can never count towards `complete`, so the first check that leaves a failure behind
  makes the next one unsatisfiable - and it fails as a timeout, which took three later
  checks with it. A download wait that gives up reports the arithmetic (expected /
  complete / interrupted / in flight), never an inventory.
- When a critical step fails, later steps are skipped rather than reported broken.
- **New behaviour ships with a new assertion.** A feature the gate cannot see is one
  the next change can break for free.

## Things an agent cannot do here

Publishing to the Chrome Web Store, anything needing a signed-in Chrome profile,
right-clicking a real page to check the menu items read well, running the grabber
against a real infinite-scroll site or a genuinely flaky network, and judging whether
the UI is pleasant. Those are the human's.
