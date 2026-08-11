// Pure core: every decision the extension makes lives here.
//
// No DOM, no chrome APIs, no clock, no randomness, no I/O - enforced by the fast
// gate. That is what makes this unit testable without a browser and what makes
// "same input, same output" an assertion instead of a hope.

export const KNOWN_FORMATS = ['png', 'jpg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'other'];

// Where downloads land, and the storage key the settings live under. Both are
// shared by the popup and the service worker: two copies of a string is two
// places for them to disagree.
export const DOWNLOAD_FOLDER = 'image-grabber';
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  minWidth: 0,
  minHeight: 0,
  includeDataUrls: false,
  formats: KNOWN_FORMATS.slice(),
  filenamePrefix: 'img'
});

export function mergeSettings(partial) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const size = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const formats = Array.isArray(input.formats)
    ? input.formats.filter(f => KNOWN_FORMATS.includes(f))
    : KNOWN_FORMATS.slice();
  const prefix = typeof input.filenamePrefix === 'string' && input.filenamePrefix.trim()
    ? input.filenamePrefix.trim()
    : DEFAULT_SETTINGS.filenamePrefix;
  return {
    minWidth: size(input.minWidth),
    minHeight: size(input.minHeight),
    includeDataUrls: input.includeDataUrls === true,
    formats,
    filenamePrefix: prefix
  };
}

function canonicalFormat(ext) {
  const value = String(ext).toLowerCase();
  if (value === 'jpeg' || value === 'jpe' || value === 'jfif') return 'jpg';
  if (value === 'svg+xml') return 'svg';
  return KNOWN_FORMATS.includes(value) ? value : 'other';
}

export function inferFormat(url) {
  const value = String(url || '');
  if (value.startsWith('data:')) {
    const match = /^data:image\/([a-z0-9.+-]+)/i.exec(value);
    return match ? canonicalFormat(match[1]) : 'other';
  }
  const clean = value.split('#')[0].split('?')[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return canonicalFormat(base.slice(dot + 1));
}

function absolute(src, pageUrl) {
  if (src.startsWith('data:')) return src;
  try {
    const resolved = new URL(src, pageUrl || undefined);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:' && resolved.protocol !== 'blob:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function dimension(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Raw candidates in, one entry per unique URL out, in first-seen order.
// The largest known size wins so a background reference cannot erase the real
// dimensions collected from an <img>.
export function normalizeCandidates(raw, pageUrl) {
  const list = Array.isArray(raw) ? raw : [];
  const byUrl = new Map();
  for (const candidate of list) {
    const src = candidate && typeof candidate.src === 'string' ? candidate.src.trim() : '';
    if (!src) continue;
    const url = absolute(src, pageUrl);
    if (!url) continue;
    const width = dimension(candidate.width);
    const height = dimension(candidate.height);
    const source = candidate.source === 'background' ? 'background' : 'img';
    const existing = byUrl.get(url);
    if (existing) {
      if (width * height > existing.width * existing.height) {
        existing.width = width;
        existing.height = height;
      }
      existing.occurrences += 1;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      continue;
    }
    byUrl.set(url, {
      id: 'i' + byUrl.size,
      url,
      width,
      height,
      format: inferFormat(url),
      isData: url.startsWith('data:'),
      alt: typeof candidate.alt === 'string' ? candidate.alt.slice(0, 120) : '',
      sources: [source],
      occurrences: 1
    });
  }
  return Array.from(byUrl.values());
}

export function applyFilters(items, settings) {
  const config = mergeSettings(settings);
  return (Array.isArray(items) ? items : []).filter(item => {
    if (item.isData && !config.includeDataUrls) return false;
    if (!config.formats.includes(item.format)) return false;
    if (item.width < config.minWidth) return false;
    if (item.height < config.minHeight) return false;
    return true;
  });
}

function sanitize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

function baseName(url) {
  const value = String(url || '');
  if (value.startsWith('data:')) return 'inline';
  const clean = value.split('#')[0].split('?')[0];
  let base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  return base;
}

// Never returns a path separator or a `..` segment: the download folder is not
// something a page-supplied URL gets to escape.
export function suggestFilename(item, index, settings) {
  const config = mergeSettings(settings);
  const prefix = sanitize(config.filenamePrefix) || 'img';
  const position = String(Math.max(0, Math.floor(Number(index) || 0)) + 1).padStart(3, '0');
  const base = sanitize(baseName(item && item.url)) || 'image';
  const format = item && item.format && item.format !== 'other' ? item.format : 'img';
  return `${prefix}-${position}-${base}.${format}`;
}

// The single place a download path is built. Filter, number, prefix the folder -
// once, for every trigger. The popup's Download button and the page context menu
// both call this; if either one assembled paths on its own the two would drift
// and only one of them would be covered by the gate.
export function planDownloads(items, settings) {
  const config = mergeSettings(settings);
  return applyFilters(items, config).map((item, index) => ({
    url: item.url,
    filename: `${DOWNLOAD_FOLDER}/${suggestFilename(item, index, config)}`
  }));
}

export function summarize(items) {
  const list = Array.isArray(items) ? items : [];
  const byFormat = {};
  for (const item of list) byFormat[item.format] = (byFormat[item.format] || 0) + 1;
  return { count: list.length, byFormat };
}
