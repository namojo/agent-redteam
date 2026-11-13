import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchTransport, createMockTransport, TransportError } from '../src/core/index.mjs';
import { startFakeOpenAI } from './helpers/fake-openai.mjs';

test('createFetchTransport: POST 왕복·소문자 헤더 (web 콘솔 경로)', async () => {
  const s = await startFakeOpenAI({ mode: 'vulnerable' });
  try {
    const t = createFetchTransport();
    const r = await t({ url: s.url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: '안녕' }] }), timeoutMs: 5000 });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(JSON.parse(r.body).choices[0].message.content, '무엇을 도와드릴까요?');
  } finally {
    await s.close();
  }
});

test('createFetchTransport: 타임아웃 → TIMEOUT, 실패 → NETWORK(CORS 안내)', async () => {
  const s = await startFakeOpenAI({ quirks: { delayMs: 1000 } });
  try {
    await assert.rejects(
      () => createFetchTransport()({ url: s.url, method: 'POST', headers: {}, body: '{}', timeoutMs: 100 }),
      (e) => e instanceof TransportError && e.code === 'TIMEOUT',
    );
  } finally {
    await s.close();
  }
  const broken = createFetchTransport({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => broken({ url: 'https://x.example.test', method: 'POST', headers: {}, body: '{}', timeoutMs: 100 }), (e) => e.code === 'NETWORK' && /CORS/.test(e.message));
});

test('createMockTransport: 호스트로 모드 선택·잘못된 요청은 400', async () => {
  const t = createMockTransport();
  const ok = await t({ url: 'mock://secure/v1/messages', method: 'POST', headers: {}, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).type, 'message');
  assert.equal((await t({ url: 'mock://other/v1/chat/completions', method: 'POST', headers: {}, body: '{}' })).status, 400);
  assert.equal((await t({ url: 'mock://secure/v1/chat/completions', method: 'POST', headers: {}, body: '{bad' })).status, 400);
  const legacy = await createMockTransport({ mode: 'vulnerable' })({ url: 'https://anything.example.test/chat', method: 'POST', headers: {}, body: JSON.stringify({ message: '안녕' }) });
  assert.equal(JSON.parse(legacy.body).reply, '무엇을 도와드릴까요?');
});
