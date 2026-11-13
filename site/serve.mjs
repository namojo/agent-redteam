#!/usr/bin/env node
// Zero-dependency static server for the built site.
//   node site/serve.mjs [--port 4173] [--host 127.0.0.1] [--dir _site]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const a = argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1];
}

const port = Number(arg('port', process.env.PORT || 4173));
const host = arg('host', '127.0.0.1');
const dir = resolve(ROOT, arg('dir', '_site'));

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port: ${arg('port')}`);
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`${dir} does not exist. Build first: node site/build.mjs`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', undefined, { Allow: 'GET, HEAD' });
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split(/[?#]/)[0]);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad Request');
  let file = resolve(dir, `.${pathname}`);
  if (file !== dir && !file.startsWith(dir + sep)) return send(res, 403, 'Forbidden');

  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) {
      const q = (req.url || '').indexOf('?');
      const loc = `${pathname}/${q >= 0 ? req.url.slice(q) : ''}`;
      return send(res, 301, `Moved to ${loc}`, undefined, { Location: encodeURI(loc) });
    }
    file = join(file, 'index.html');
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    console.log(`404 ${req.method} ${req.url}`);
    return send(res, 404, `Not Found: ${pathname}`);
  }
  const { size } = statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  const { port: actual } = server.address();
  console.log(`serving ${dir} at http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}/`);
});
