import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCssUrls, expandStyleCandidates, scanCoverage, SCAN_ELEMENT_LIMIT } from '../../src/core/images.js';

// The inputs below are the shapes a COMPUTED style actually produces (absolute
// urls, double quotes, layers separated by commas) plus the authored shapes that
// reach us through inline styles. The regex this replaced could not parse the
// third test at all, and returned nothing rather than something wrong - which is
// why the bug survived: a missing image looks exactly like a page without one.

test('an empty or absent value yields no urls', () => {
  assert.deepEqual(parseCssUrls('none'), []);
  assert.deepEqual(parseCssUrls(''), []);
  assert.deepEqual(parseCssUrls(null), []);
  assert.deepEqual(parseCssUrls(undefined), []);
  assert.deepEqual(parseCssUrls(42), []);
});

test('reads a plain double-quoted url', () => {
  assert.deepEqual(parseCssUrls('url("http://e.com/a.png")'), ['http://e.com/a.png']);
});

test('keeps brackets INSIDE a quoted url - the case the old regex dropped', () => {
  assert.deepEqual(parseCssUrls('url("http://e.com/shot(2).png")'), ['http://e.com/shot(2).png']);
  assert.deepEqual(parseCssUrls("url('http://e.com/a(1)(2).png')"), ['http://e.com/a(1)(2).png']);
});

test('accepts an unquoted url and trims the padding around it', () => {
  assert.deepEqual(parseCssUrls('url( http://e.com/b.png )'), ['http://e.com/b.png']);
  assert.deepEqual(parseCssUrls('url(http://e.com/c.png)'), ['http://e.com/c.png']);
});

test('one declaration can name several images', () => {
  assert.deepEqual(
    parseCssUrls('url("http://e.com/d.png"), url("http://e.com/e.png")'),
    ['http://e.com/d.png', 'http://e.com/e.png']
  );
});

test('picks the url out of a layer list that also holds a gradient', () => {
  assert.deepEqual(
    parseCssUrls('linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255)), url("http://e.com/f.png")'),
    ['http://e.com/f.png']
  );
});

test('reads both entries of an image-set', () => {
  assert.deepEqual(
    parseCssUrls('image-set(url("http://e.com/g.png") 1x, url("http://e.com/h.png") 2x)'),
    ['http://e.com/g.png', 'http://e.com/h.png']
  );
});

test('unescapes an escaped quote inside a quoted url', () => {
  assert.deepEqual(parseCssUrls('url("http://e.com/i\\"quote.png")'), ['http://e.com/i"quote.png']);
});

test('an empty url() contributes nothing', () => {
  assert.deepEqual(parseCssUrls('url()'), []);
  assert.deepEqual(parseCssUrls('url("")'), []);
  assert.deepEqual(parseCssUrls('url(   )'), []);
});

test('a truncated declaration is not a url', () => {
  assert.deepEqual(parseCssUrls('url("http://e.com/j.png'), []);
  assert.deepEqual(parseCssUrls('url("http://e.com/j.png"'), []);
});

test('a function that merely ends in "url" is not a url token', () => {
  assert.deepEqual(parseCssUrls('myurl("http://e.com/k.png")'), []);
  assert.deepEqual(parseCssUrls('-x-url("http://e.com/k.png")'), []);
});

test('data urls survive, and the function name is case insensitive', () => {
  assert.deepEqual(parseCssUrls('url(data:image/png;base64,AAA=)'), ['data:image/png;base64,AAA=']);
  assert.deepEqual(parseCssUrls('URL("http://e.com/l.png")'), ['http://e.com/l.png']);
});

test('expandStyleCandidates yields one background candidate per url and keeps its origin', () => {
  const out = expandStyleCandidates([
    { origin: 'element', value: 'url("http://e.com/a.png")' },
    { origin: '::before', value: 'url("http://e.com/b.png"), url("http://e.com/c.png")' }
  ]);
  assert.deepEqual(out.map(c => c.src), ['http://e.com/a.png', 'http://e.com/b.png', 'http://e.com/c.png']);
  assert.deepEqual(out.map(c => c.origin), ['element', '::before', '::before']);
  assert.ok(out.every(c => c.source === 'background' && c.width === 0 && c.height === 0));
});

test('expandStyleCandidates ignores junk entries instead of throwing', () => {
  assert.deepEqual(expandStyleCandidates(null), []);
  assert.deepEqual(expandStyleCandidates([null, {}, { value: 7 }, { value: 'none' }]), []);
});

test('a complete walk reports complete and carries no warning', () => {
  const coverage = scanCoverage({ elementLimit: SCAN_ELEMENT_LIMIT, elementsTotal: 120, elementsScanned: 120 });
  assert.equal(coverage.complete, true);
  assert.equal(coverage.warning, null);
});

test('a truncated walk is incomplete, says how much it saw, and never both', () => {
  const coverage = scanCoverage({ elementLimit: 4000, elementsTotal: 4211, elementsScanned: 4000 });
  assert.equal(coverage.complete, false);
  assert.match(coverage.warning, /INCOMPLETE/);
  assert.match(coverage.warning, /4000 of 4211/);
});

// "We could not tell" and "we saw all of it" must not be the same answer. A
// collector that stops reporting coverage would otherwise silently promote every
// page to a clean scan - the quietest possible regression.
test('a missing or malformed coverage report reads as incomplete', () => {
  for (const input of [null, undefined, {}, { elementLimit: 4000 }, { elementsTotal: 'lots' }]) {
    const coverage = scanCoverage(input);
    assert.equal(coverage.complete, false, `expected incomplete for ${JSON.stringify(input)}`);
    assert.match(coverage.warning, /INCOMPLETE/);
  }
});
