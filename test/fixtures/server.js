// Fixture web server. Images are generated on the fly so the repo stays free of
// binary blobs and every image has an exactly known size.
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
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const image = /^\/img\/(\d+)x(\d+)\.(png|jpg)$/.exec(url.pathname);
    if (image) {
      // Note: the .jpg route serves PNG bytes on purpose. Format classification is
      // URL based by design, so this exercises the classifier without shipping a
      // JPEG encoder. Chrome sniffs the content and renders it fine.
      const buf = gradient(Number(image[1]), Number(image[2]));
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
      res.end(buf);
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
        close: () => new Promise(done => server.close(() => done()))
      });
    });
  });
}
