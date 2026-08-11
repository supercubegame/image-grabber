// Fixture web server. Images are generated on the fly so the repo stays free of
// binary blobs and every image has an exactly known size.
//
// It also fails on purpose, and counts those failures. A retry test run against a
// server that never actually failed passes exactly the same way as one run against
// a server that did, so `stats()` is not a debugging convenience - it is what makes
// those assertions mean anything.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../scripts/lib/png.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const IMAGE_RE = /^\/img\/(\d+)x(\d+)\.(png|jpg)$/;
// 500 for the first <fails> requests to this exact path, then the real image.
const FLAKY_RE = /^\/flaky\/(\d+)\/(\d+)x(\d+)\.png$/;
// The image the FIRST time, 500 every time after. A fixture page can render it
// without logging a console error while every later request - i.e. every download
// attempt - fails permanently.
const ONCE_RE = /^\/once\/(\d+)x(\d+)\.png$/;

// Deterministic gradient: gives screenshots plenty of distinct colours to count.
function gradient(width, height) {
  return encodePng(width, height, (x, y) => [
    Math.floor((x * 255) / Math.max(1, width - 1)),
    Math.floor((y * 255) / Math.max(1, height - 1)),
    (x + y + width) % 256,
    255
  ]);
}

export function startServer(port = 0) {
  const counters = new Map();
  const count = pathname => {
    const entry = counters.get(pathname) || { requests: 0, failures: 0, successes: 0 };
    entry.requests += 1;
    counters.set(pathname, entry);
    return entry;
  };

  const sendImage = (res, width, height) => {
    const buf = gradient(width, height);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
    res.end(buf);
  };
  const sendFailure = (res, why) => {
    res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(why);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    // A real browser asks for this unprompted. Answering 404 makes the
    // zero-console-errors check fail for a reason that has nothing to do with the
    // extension - and that check is worth keeping strict.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const flaky = FLAKY_RE.exec(url.pathname);
    if (flaky) {
      const entry = count(url.pathname);
      const budget = Number(flaky[1]);
      if (entry.failures < budget) {
        entry.failures += 1;
        sendFailure(res, `flaky fixture: failing on purpose (${entry.failures} of ${budget})`);
        return;
      }
      entry.successes += 1;
      sendImage(res, Number(flaky[2]), Number(flaky[3]));
      return;
    }

    const once = ONCE_RE.exec(url.pathname);
    if (once) {
      const entry = count(url.pathname);
      if (entry.successes === 0) {
        entry.successes += 1;
        sendImage(res, Number(once[1]), Number(once[2]));
        return;
      }
      entry.failures += 1;
      sendFailure(res, 'once fixture: this image was only ever going to work one time');
      return;
    }

    const image = IMAGE_RE.exec(url.pathname);
    if (image) {
      // Note: the .jpg route serves PNG bytes on purpose. Format classification is
      // URL based by design, so this exercises the classifier without shipping a
      // JPEG encoder. Chrome sniffs the content and renders it fine.
      count(url.pathname).successes += 1;
      sendImage(res, Number(image[1]), Number(image[2]));
      return;
    }

    const rel = url.pathname === '/' ? 'gallery.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(DIR, rel);
    if (!file.startsWith(DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        // Plain object, safe to drop straight into a failure report.
        stats: () => Object.fromEntries(Array.from(counters.entries()).map(([key, value]) => [key, { ...value }])),
        // Called before a retry check so that a page which already rendered the
        // image does not eat the failures the DOWNLOAD is supposed to see.
        reset: () => counters.clear(),
        close: () => new Promise(done => server.close(() => done()))
      });
    });
  });
}
