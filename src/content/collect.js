// Injected with chrome.scripting.executeScript({ files: [...] }).
//
// Must stay a classic, SYNCHRONOUS script: the completion value of the last
// statement is what the injection returns, and we deliberately do not depend on
// the scripting API awaiting a promise.
//
// It collects raw candidates only. Dedupe, URL resolution, format inference and
// filtering all live in src/core/images.js so they can be unit tested.
(() => {
  const MAX_ELEMENTS = 4000;
  const URL_RE = /url\((['"]?)([^'")]+)\1\)/g;
  const candidates = [];

  for (const img of document.images) {
    candidates.push({
      src: img.currentSrc || img.getAttribute('src') || '',
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      source: 'img',
      alt: img.alt || ''
    });
  }

  const elements = document.querySelectorAll('*');
  const limit = Math.min(elements.length, MAX_ELEMENTS);
  for (let i = 0; i < limit; i++) {
    const background = getComputedStyle(elements[i]).backgroundImage;
    if (!background || background === 'none') continue;
    URL_RE.lastIndex = 0;
    let match;
    while ((match = URL_RE.exec(background)) !== null) {
      candidates.push({ src: match[2], width: 0, height: 0, source: 'background', alt: '' });
    }
  }

  return { pageUrl: location.href, title: document.title, candidates };
})();
