// Injected with chrome.scripting.executeScript({ files: [...] }).
//
// Must stay a classic, SYNCHRONOUS script: the completion value of the last
// statement is what the injection returns, and we deliberately do not depend on
// the scripting API awaiting a promise.
//
// It REPORTS, it does not decide. Raw computed `background-image` strings go back
// unparsed: url() parsing, dedupe, resolution, format inference and filtering all
// live in src/core/images.js, where they can be unit tested. Nothing in here can.
(() => {
  // Copy of SCAN_ELEMENT_LIMIT in src/core/images.js - an injected classic script
  // cannot import a module. The fast gate compares the two numbers.
  const MAX_ELEMENTS = 4000;
  const candidates = [];
  const styles = [];

  // A pseudo-element that was never GENERATED still answers getComputedStyle, so a
  // rule that sets a background without `content` would otherwise contribute an
  // image that is nowhere on the page. Chrome reports `none` for those; `normal`
  // is the spec's initial value and means the same thing here.
  const generated = content => Boolean(content) && content !== 'none' && content !== 'normal';

  const collectStyle = (origin, value) => {
    if (!value || value === 'none') return;
    styles.push({ origin, value });
  };

  for (const img of document.images) {
    candidates.push({
      src: img.currentSrc || img.getAttribute('src') || '',
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      source: 'img',
      alt: img.alt || ''
    });
  }

  // The cap is on the ELEMENT WALK only - document.images above is always walked in
  // full. Whatever it cuts off is reported below rather than silently dropped.
  const elements = document.querySelectorAll('*');
  const elementsTotal = elements.length;
  const elementsScanned = Math.min(elementsTotal, MAX_ELEMENTS);
  for (let i = 0; i < elementsScanned; i++) {
    const element = elements[i];
    collectStyle('element', getComputedStyle(element).backgroundImage);
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      if (!generated(style.content)) continue;
      collectStyle(pseudo, style.backgroundImage);
    }
  }

  return {
    pageUrl: location.href,
    title: document.title,
    candidates,
    styles,
    coverage: { elementLimit: MAX_ELEMENTS, elementsTotal, elementsScanned }
  };
})();
