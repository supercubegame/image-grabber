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
  // Colour thresholds keep a wide margin: the populated popup renders five gradient
  // thumbnails and measures in the hundreds. These only catch a blank render.
  minColorsPopulated: 40,
  minColorDelta: 30
};
