import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestFilename } from '../../src/core/images.js';

const item = (over = {}) => ({ url: 'https://e.com/photos/Sun Set!.png', format: 'png', ...over });

test('numbers, sanitises and keeps the format extension', () => {
  assert.equal(suggestFilename(item(), 0, {}), 'img-001-sun-set.png');
});

test('is deterministic for the same input', () => {
  assert.equal(suggestFilename(item(), 4, {}), suggestFilename(item(), 4, {}));
  assert.equal(suggestFilename(item(), 4, {}), 'img-005-sun-set.png');
});

test('data urls get a stable placeholder name', () => {
  assert.equal(suggestFilename(item({ url: 'data:image/png;base64,AAA' }), 0, {}), 'img-001-inline.png');
});

test('unknown formats fall back to .img instead of a bogus extension', () => {
  assert.equal(suggestFilename(item({ url: 'https://e.com/thing', format: 'other' }), 0, {}), 'img-001-thing.img');
});

test('a hostile prefix cannot escape the download folder', () => {
  const name = suggestFilename(item(), 0, { filenamePrefix: '../../etc' });
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('..'), false);
});
