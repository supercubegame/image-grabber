// One scroll round, injected by the service worker.
//
// Classic and SYNCHRONOUS, exactly like collect.js: it measures the page as it is
// right now and then asks the browser to scroll. The waiting, the loop and the
// "are we at the bottom?" decision all live in the worker and src/core/scroll.js,
// where they can be tested without a page. A script that scrolled and waited on
// its own would move the only interesting logic somewhere nothing can assert it.
//
// Measure BEFORE scrolling on purpose: this round's numbers describe the result of
// the previous round's scroll, and those consecutive pairs are what the state
// machine compares.
(() => {
  const doc = document.documentElement;
  const body = document.body;
  const height = Math.max(
    (doc && Number(doc.scrollHeight)) || 0,
    (body && Number(body.scrollHeight)) || 0,
    (doc && Number(doc.offsetHeight)) || 0
  );

  // Only <img> elements are counted. CSS background images are collected later by
  // collect.js but they are a poor growth signal: a lazy list usually adds <img>
  // nodes, and backgrounds churn on hover. Counting them would make the criterion
  // noisier for no gain.
  const measurement = {
    imageCount: document.images.length,
    scrollHeight: height,
    scrollY: Math.round(window.scrollY || 0),
    innerHeight: Math.round(window.innerHeight || 0),
    url: location.href
  };

  window.scrollTo(0, height);
  return measurement;
})();
