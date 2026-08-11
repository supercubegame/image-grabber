# Image Grabber — project rules

Chrome MV3 extension. Scans the active tab for images, filters them by size and
format, downloads the selected ones through `chrome.downloads`.

## Layout

```
manifest.json                 MV3 manifest (extension root = repo root)
src/core/images.js            pure logic: normalise, dedupe, filter, name files
src/content/collect.js        injected collector, classic + synchronous
src/background/service_worker.js  the only place touching chrome.scripting/downloads
src/popup/                    popup UI, probing, rendering
scripts/verify.js             fast gate (no dependencies, seconds)
scripts/verify-e2e.js         browser gate (headless Chrome, real behaviour)
scripts/compose-report.js     merges gate reports into the CI comment
test/unit/                    node:test unit tests for src/core
test/fixtures/                fixture server + gallery pages + expected numbers
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

1. **`src/core/images.js` stays pure.** No DOM, no `chrome.*`, no `Date.now()`, no
   unseeded randomness, no I/O. The fast gate greps for these and fails. Purity is
   what makes "same input, same output" assertable and lets the logic be unit tested
   without a browser.
2. **`window.__DIAG__` (popup) and `self.__DIAG__` (service worker) are read-only
   diagnostic surfaces for the gate.** Fields may be ADDED, never renamed or removed.
   Rename one and the gate goes quiet instead of red.
3. **`src/content/collect.js` stays a classic, synchronous script.** Its last
   expression is the injection's return value; we deliberately do not depend on the
   scripting API awaiting a promise. It collects raw candidates only - dedupe, URL
   resolution and format inference belong to the pure core.
4. **The popup's `?tabId=` query param is a read-only override** used by the gate. The
   popup still defaults to the active tab.
5. **Downloads always land in the `image-grabber/` subfolder** and filenames are
   sanitised in `suggestFilename` (no slashes, no `..`).

## Coupled parameters — change one, recheck the other

- `PROBE_TIMEOUT_MS` (src/popup/popup.js, 4000) ↔ `POLL_TIMEOUT_MS`
  (scripts/verify-e2e.js, 20000). Polling must outlast the worst-case probe, with
  margin, or scan assertions turn into flaky timeouts.
- `test/fixtures/gallery.html` ↔ `test/fixtures/expected.js`. Every count the browser
  gate asserts is hand-computed from the fixture. Edit the fixture, recompute the
  numbers. Never derive them at runtime - a test that agrees with the code by
  construction tests nothing.
- `MIN_UNIT_FILES` / `MIN_UNIT_TESTS` (scripts/verify.js) ↔ `test/unit/*`. They exist
  so a runner that finds no tests fails loudly instead of exiting 0.

## Gate rules

- Assert real behaviour: the extension loaded, the list rendered, pixels changed,
  files hit the disk. Never assert that a function exists.
- Poll until a condition holds; never `sleep(n)` and hope. Predicates return booleans.
- Every failure must carry evidence (expected vs actual, or output tail). If the
  posted comment alone cannot get you to the root cause, the report is incomplete.
- Colour and timing thresholds only catch "nothing rendered" / "hung". Keep at least
  3x margin; CI has no GPU and shared CPU.
- When a critical step fails, later steps are skipped rather than reported as broken.

## Things an agent cannot do here

Publishing to the Chrome Web Store, anything needing a signed-in Chrome profile, and
judging whether the UI is pleasant to use. Those are the human's.
