# Image Grabber

A Chrome MV3 extension that scans the current page for images, filters them by size
and format, and downloads them in bulk.

## Try it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder
3. Open any image-heavy page, then either:
   - click the toolbar icon to pick images by hand, or
   - right-click anywhere on the page → **Download all images on this page**

The right-click route reuses whatever filters you last set in the popup and shows the
number of queued files on the toolbar badge. Downloads land in `image-grabber/` inside
your Chrome download folder.

## Verify

```
npm run verify                       # fast gate, no dependencies
npm install && npm run verify:e2e    # browser gate, headless Chrome
```

CI runs both on every push and writes a single report with evidence back to the pull
request. See `AGENTS.md` for the project rules.
