// Every number the browser gate asserts, in one place.
//
// These are coupled to test/fixtures/gallery.html - change the fixture and you must
// recompute these. Deriving them at runtime would make the gate agree with whatever
// the code happens to do, which is the opposite of a test.
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
  minColorDelta: 400
};
