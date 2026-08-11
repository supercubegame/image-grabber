import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidates } from '../../src/core/images.js';

const PAGE = 'https://example.com/gallery/index.html';

test('resolves relative sources against the page url', () => {
  const items = normalizeCandidates([{ src: '../a/pic.png', width: 10, height: 10, source: 'img' }], PAGE);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/a/pic.png');
});

test('dedupes the same url across img and background and keeps the largest known size', () => {
  const items = normalizeCandidates([
    { src: 'p.png', width: 0, height: 0, source: 'background' },
    { src: 'p.png', width: 400, height: 300, source: 'img' },
    { src: 'p.png', width: 0, height: 0, source: 'img' }
  ], PAGE);
  assert.equal(items.length, 1);
  assert.equal(items[0].width, 400);
  assert.equal(items[0].height, 300);
  assert.equal(items[0].occurrences, 3);
});

test('keeps first-seen order and assigns stable ids', () => {
  const raw = [
    { src: 'a.png', width: 1, height: 1, source: 'img' },
    { src: 'b.png', width: 1, height: 1, source: 'img' }
  ];
  const first = normalizeCandidates(raw, PAGE);
  const second = normalizeCandidates(raw, PAGE);
  assert.deepEqual(first.map(i => i.id), ['i0', 'i1']);
  assert.deepEqual(first.map(i => i.url), second.map(i => i.url));
});

test('drops empty and unresolvable sources', () => {
  const items = normalizeCandidates([
    { src: '', width: 1, height: 1, source: 'img' },
    { src: '   ', width: 1, height: 1, source: 'img' },
    { src: 'javascript:void(0)', width: 1, height: 1, source: 'img' },
    { src: 'ok.png', width: 1, height: 1, source: 'img' }
  ], PAGE);
  assert.deepEqual(items.map(i => i.url), ['https://example.com/gallery/ok.png']);
});

test('flags data urls and infers their format', () => {
  const items = normalizeCandidates([{ src: 'data:image/gif;base64,AAAA', width: 1, height: 1, source: 'img' }], PAGE);
  assert.equal(items[0].isData, true);
  assert.equal(items[0].format, 'gif');
});
