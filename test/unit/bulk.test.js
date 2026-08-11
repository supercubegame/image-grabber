import test from 'node:test';
import assert from 'node:assert/strict';
import { planDownloads, DOWNLOAD_FOLDER } from '../../src/core/images.js';

const item = (over = {}) => ({
  url: 'https://e.com/a.png', width: 100, height: 100, format: 'png', isData: false, occurrences: 1, ...over
});

test('plans one download per surviving item, in order', () => {
  const plan = planDownloads([item(), item({ url: 'https://e.com/b.png' })], {});
  assert.deepEqual(plan.map(p => p.url), ['https://e.com/a.png', 'https://e.com/b.png']);
  assert.deepEqual(plan.map(p => p.filename), [
    'image-grabber/img-001-a.png',
    'image-grabber/img-002-b.png'
  ]);
});

test('every planned path is exactly one segment inside the download folder', () => {
  const plan = planDownloads([
    item({ url: 'https://e.com/deep/nested/path/pic.png' }),
    item({ url: 'https://e.com/../../etc/passwd.png' })
  ], { filenamePrefix: '../../etc' });
  assert.equal(plan.length, 2);
  for (const entry of plan) {
    assert.equal(entry.filename.startsWith(DOWNLOAD_FOLDER + '/'), true);
    assert.equal(entry.filename.split('/').length, 2);
    assert.equal(entry.filename.includes('..'), false);
  }
});

test('applies the saved filters instead of downloading everything', () => {
  const items = [
    item({ width: 400, height: 300 }),
    item({ url: 'https://e.com/small.png', width: 50, height: 50 }),
    item({ url: 'data:image/png;base64,AAA', isData: true }),
    item({ url: 'https://e.com/c.jpg', format: 'jpg', width: 400, height: 300 })
  ];
  assert.equal(planDownloads(items, {}).length, 3);
  assert.equal(planDownloads(items, { minWidth: 200 }).length, 2);
  assert.equal(planDownloads(items, { formats: ['png'] }).length, 2);
  assert.equal(planDownloads(items, { includeDataUrls: true }).length, 4);
});

test('numbering follows the plan, not the input list', () => {
  // The small image is filtered out, so the jpg after it must still be 002 - an
  // off-by-one here would show up as a gap in the downloaded file names.
  const plan = planDownloads([
    item(),
    item({ url: 'https://e.com/small.png', width: 50, height: 50 }),
    item({ url: 'https://e.com/c.jpg', format: 'jpg' })
  ], { minWidth: 100 });
  assert.deepEqual(plan.map(p => p.filename), [
    'image-grabber/img-001-a.png',
    'image-grabber/img-002-c.jpg'
  ]);
});

test('is deterministic and plans nothing for junk input', () => {
  const items = [item(), item({ url: 'https://e.com/b.png' })];
  assert.deepEqual(planDownloads(items, {}), planDownloads(items, {}));
  assert.deepEqual(planDownloads([], {}), []);
  assert.deepEqual(planDownloads(null, null), []);
});

test('a custom prefix reaches the planned filenames', () => {
  const plan = planDownloads([item()], { filenamePrefix: 'Shoot 2026' });
  assert.equal(plan[0].filename, 'image-grabber/shoot-2026-001-a.png');
});
