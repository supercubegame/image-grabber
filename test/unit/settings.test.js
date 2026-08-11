import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, DEFAULT_SETTINGS, KNOWN_FORMATS } from '../../src/core/images.js';

test('missing or junk input falls back to the defaults', () => {
  assert.deepEqual(mergeSettings(null), { ...DEFAULT_SETTINGS, formats: KNOWN_FORMATS.slice() });
  assert.deepEqual(mergeSettings('nonsense').formats, KNOWN_FORMATS.slice());
});

test('negative and non-numeric sizes are clamped to zero', () => {
  assert.equal(mergeSettings({ minWidth: -10 }).minWidth, 0);
  assert.equal(mergeSettings({ minHeight: 'big' }).minHeight, 0);
  assert.equal(mergeSettings({ minWidth: 200.7 }).minWidth, 200);
});

test('unknown formats are dropped but an explicit empty list is respected', () => {
  assert.deepEqual(mergeSettings({ formats: ['png', 'tiff'] }).formats, ['png']);
  assert.deepEqual(mergeSettings({ formats: [] }).formats, []);
});
