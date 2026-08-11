// Some candidates arrive without dimensions: CSS backgrounds have no intrinsic
// size, and lazy-loaded <img> elements may not have decoded yet. Loading the image
// in the popup is the only way to learn the real size before filtering on it.
export function probeDimensions(url, timeoutMs) {
  return new Promise(resolve => {
    const img = new Image();
    let timer = null;
    let settled = false;
    const finish = (width, height) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve({ width, height });
    };
    timer = setTimeout(() => finish(0, 0), timeoutMs);
    img.onload = () => finish(img.naturalWidth || 0, img.naturalHeight || 0);
    img.onerror = () => finish(0, 0);
    img.src = url;
  });
}
