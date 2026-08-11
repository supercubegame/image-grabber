import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, inferFormat } from '../../src/core/images.js';

const item = (over = {}) => ({
  url: 'https://e.com/a.png', width: 100, height: 100, format: 'png', isData: false, occurrences: 1, ...over
});

test('data urls are hidden unless explicitly included', () => {
  const items = [item(), item({ url: 'data:image/png;base64,A', isData: true })];
  assert.equal(applyFilters(items, {}).length, 1);
  assert.equal(applyFilters(items, { includeDataUrls: true }).length, 2);
});

test('minimum size excludes smaller images and unknown sizes', () => {
  const items = [item({ width: 400, height: 300 }), item({ width: 50, height: 50 }), item({ width: 0, height: 0 })];
  assert.equal(applyFilters(items, { minWidth: 200 }).length, 1);
  assert.equal(applyFilters(items, { minHeight: 200 }).length, 1);
  assert.equal(applyFilters(items, {}).length, 3);
});

test('format filter keeps only the requested formats', () => {
  const items = [item({ format: 'png' }), item({ format: 'jpg' }), item({ format: 'webp' })];
  assert.deepEqual(applyFilters(items, { formats: ['png', 'webp'] }).map(i => i.format), ['png', 'webp']);
});

test('an empty format list hides everything', () => {
  assert.equal(applyFilters([item(), item()], { formats: [] }).length, 0);
});

test('format inference handles extensions, query strings and aliases', () => {
  assert.equal(inferFormat('https://e.com/a.JPEG'), 'jpg');
  assert.equal(inferFormat('https://e.com/a.png?v=2#x'), 'png');
  assert.equal(inferFormat('https://e.com/a'), 'other');
  assert.equal(inferFormat('https://e.com/a.tiff'), 'other');
  assert.equal(inferFormat('data:image/svg+xml,<svg/>'), 'svg');
});
