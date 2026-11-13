import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createNodeTransport } from '../src/node/transport.mjs';
import { TransportError } from '../src/core/index.mjs';

function echoServer(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const srv = createServer(handler);
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/x`,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
    }));
  });
}

test('POST 왕복·상태·소문자 헤더', async () => {
  const srv = await echoServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.writeHead(201, { 'X-Custom-Header': 'v', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body: b, auth: req.headers.authorization }));
    });
  });
  try {
    const t = createNodeTransport();
    const r = await t({ url: srv.url, method: 'POST', headers: { authorization: 'Bearer a' }, body: '{"q":1}', timeoutMs: 5000 });
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-custom-header'], 'v');
    assert.deepEqual(JSON.parse(r.body), { method: 'POST', body: '{"q":1}', auth: 'Bearer a' });
    const err = await t({ url: srv.url, method: 'GET', headers: {}, body: undefined, timeoutMs: 5000 });
    assert.equal(err.status, 201, '4xx/5xx/any status resolves, never rejects');
  } finally {
    await srv.close();
  }
});

test('content-length는 UTF-8 바이트', async () => {
  let seen;
  const srv = await echoServer((req, res) => { seen = req.headers['content-length']; req.resume(); req.on('end', () => res.end('ok')); });
  try {
    const body = JSON.stringify({ m: '한국어 텍스트' });
    await createNodeTransport()({ url: srv.url, method: 'POST', headers: {}, body, timeoutMs: 5000 });
    assert.equal(Number(seen), new TextEncoder().encode(body).length);
    assert.notEqual(Number(seen), body.length);
  } finally {
    await srv.close();
  }
});

test('타임아웃 → TIMEOUT', async () => {
  const srv = await echoServer(() => { /* never respond */ });
  try {
    await assert.rejects(
      () => createNodeTransport()({ url: srv.url, method: 'POST', headers: {}, body: '{}', timeoutMs: 200 }),
      (e) => e instanceof TransportError && e.code === 'TIMEOUT',
    );
  } finally {
    await srv.close();
  }
});

test('연결 거부 → NETWORK', async () => {
  const srv = await echoServer((req, res) => res.end());
  const url = srv.url;
  await srv.close();
  await assert.rejects(
    () => createNodeTransport()({ url, method: 'POST', headers: {}, body: '{}', timeoutMs: 3000 }),
    (e) => e instanceof TransportError && e.code === 'NETWORK',
  );
});

function fakeRequest({ onCall, error, status = 200, body = 'ok' } = {}) {
  return (url, options, cb) => {
    onCall && onCall(url, options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        if (error) { req.emit('error', error); return; }
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = { 'Content-Type': 'text/plain' };
        cb(res);
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    };
    return req;
  };
}

test('https 옵션 ca·rejectUnauthorized 전달(_request 주입)', async () => {
  let seen;
  const t = createNodeTransport({ ca: 'PEM-DATA', insecure: true, _request: fakeRequest({ onCall: (u, o) => { seen = { u: String(u), o }; } }) });
  const r = await t({ url: 'https://llm.example.test/v1/chat/completions', method: 'POST', headers: { a: 'b' }, body: '{}', timeoutMs: 1000 });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'ok');
  assert.equal(r.headers['content-type'], 'text/plain');
  assert.equal(seen.o.ca, 'PEM-DATA');
  assert.equal(seen.o.rejectUnauthorized, false);
  assert.equal(seen.o.method, 'POST');
  assert.equal(seen.o.headers['content-length'], '2');
  const strict = createNodeTransport({ _request: fakeRequest({ onCall: (u, o) => { seen = { o }; } }) });
  await strict({ url: 'https://llm.example.test/', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 });
  assert.equal(seen.o.rejectUnauthorized, true);
  assert.ok(!('ca' in seen.o));
});

test('TLS 오류 코드 매핑(_request 주입)', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const e = Object.assign(new Error('tls failure'), { code });
    const t = createNodeTransport({ _request: fakeRequest({ error: e }) });
    await assert.rejects(
      () => t({ url: 'https://llm.example.test/', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 }),
      (err) => err.code === 'TLS' && /NODE_EXTRA_CA_CERTS/.test(err.message),
      code,
    );
  }
  const reset = createNodeTransport({ _request: fakeRequest({ error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }) });
  await assert.rejects(() => reset({ url: 'https://llm.example.test/', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 }), (err) => err.code === 'NETWORK');
});
