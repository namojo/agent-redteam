import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, TransportError } from '../src/core/index.mjs';

const TARGET = {
  provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm', apiKey: 'secret-key-1234', headers: { 'x-gw': 'gateway-secret-9' },
  systemRole: 'system', systemPrompt: '', temperature: 0, maxTokens: null, extraBody: {}, sendTools: true, method: 'POST', body: '', responsePath: '', toolCallsPath: '',
};
const NET = { timeoutMs: 5000, retries: 2, retryBaseDelayMs: 500, rpm: 0, delayMs: 0 };
const OK = { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) };
const INPUT = { system: '', messages: [{ role: 'user', content: 'x' }], tools: null };

function fakeClock() {
  let t = 1000;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms) => { t += ms; } };
}

function scripted(responses) {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { transport, calls };
}

test('429 후 성공: retry-after 사용, attempts 2', async () => {
  const clock = fakeClock();
  const { transport, calls } = scripted([{ status: 429, headers: { 'retry-after': '3' }, body: '' }, OK]);
  const res = await createClient(TARGET, { transport, network: NET, ...clock }).send(INPUT);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hi');
  assert.equal(res.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.sleeps, [3000]);
});

test('500이 retries+1번이면 HTTP 오류', async () => {
  const clock = fakeClock();
  const { transport, calls } = scripted([{ status: 500, headers: {}, body: 'boom' }]);
  const res = await createClient(TARGET, { transport, network: NET, ...clock }).send(INPUT);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'HTTP');
  assert.equal(res.error.status, 500);
  assert.match(res.error.message, /^HTTP 500 · boom/);
  assert.equal(res.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [500, 1000], 'exponential backoff');
});

test('400·TIMEOUT·TLS는 재시도 안 함', async () => {
  for (const r of [{ status: 400, headers: {}, body: 'bad' }, new TransportError('TIMEOUT', 't'), new TransportError('TLS', 'tls')]) {
    const { transport, calls } = scripted([r, OK]);
    const res = await createClient(TARGET, { transport, network: NET, ...fakeClock() }).send(INPUT);
    assert.equal(res.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(res.error.code, r instanceof Error ? r.code : 'HTTP');
  }
});

test('PARSE·RESPONSE_PATH는 재시도 안 함', async () => {
  const { transport, calls } = scripted([{ status: 200, headers: {}, body: '<html>' }, OK]);
  const res = await createClient(TARGET, { transport, network: NET, ...fakeClock() }).send(INPUT);
  assert.equal(res.error.code, 'PARSE');
  assert.equal(calls.length, 1);
  const http = { ...TARGET, provider: 'http', body: '{"m":"{{PROMPT}}"}', responsePath: 'nope' };
  const s = scripted([{ status: 200, headers: {}, body: '{"reply":"x"}' }]);
  const r2 = await createClient(http, { transport: s.transport, network: NET, ...fakeClock() }).send(INPUT);
  assert.equal(r2.error.code, 'RESPONSE_PATH');
});

test('NETWORK는 재시도', async () => {
  const { transport, calls } = scripted([new TransportError('NETWORK', 'reset'), OK]);
  const res = await createClient(TARGET, { transport, network: NET, ...fakeClock() }).send(INPUT);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  const plain = scripted([new Error('socket hang up')]);
  const r2 = await createClient(TARGET, { transport: plain.transport, network: { ...NET, retries: 1 }, ...fakeClock() }).send(INPUT);
  assert.equal(r2.error.code, 'NETWORK', 'unknown errors are treated as NETWORK');
  assert.equal(plain.calls.length, 2);
});

test('백오프 상한 30초', async () => {
  const clock = fakeClock();
  const { transport } = scripted([{ status: 503, headers: { 'retry-after': '120' }, body: '' }, { status: 503, headers: {}, body: '' }, OK]);
  await createClient(TARGET, { transport, network: { ...NET, retryBaseDelayMs: 100000 }, ...clock }).send(INPUT);
  assert.deepEqual(clock.sleeps, [30000, 30000]);
});

test('rpm 간격(가짜 시계)', async () => {
  const clock = fakeClock();
  const { transport, calls } = scripted([OK]);
  const starts = [];
  const wrapped = createClient(TARGET, {
    transport: async (r) => { starts.push(clock.now()); return transport(r); }, network: { ...NET, rpm: 60 }, ...clock,
  });
  await wrapped.send(INPUT);
  await wrapped.send(INPUT);
  await wrapped.send(INPUT);
  assert.equal(starts[1] - starts[0], 1000);
  assert.equal(starts[2] - starts[1], 1000);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [1000, 1000]);
});

test('delayMs는 두 번째 요청부터', async () => {
  const clock = fakeClock();
  const { transport } = scripted([OK]);
  const client = createClient(TARGET, { transport, network: { ...NET, delayMs: 250 }, ...clock });
  await client.send(INPUT);
  assert.deepEqual(clock.sleeps, []);
  await client.send(INPUT);
  assert.deepEqual(clock.sleeps, [250]);
});

test('오류 메시지에서 apiKey 마스킹', async () => {
  const { transport } = scripted([{ status: 401, headers: {}, body: 'invalid key secret-key-1234 header gateway-secret-9' }]);
  const res = await createClient(TARGET, { transport, network: NET, ...fakeClock() }).send(INPUT);
  assert.ok(!res.error.message.includes('secret-key-1234'));
  assert.ok(!res.error.message.includes('gateway-secret-9'));
  assert.match(res.error.message, /\*\*\*/);
  const t2 = scripted([new TransportError('NETWORK', 'connect failed with secret-key-1234')]);
  const r2 = await createClient(TARGET, { transport: t2.transport, network: { ...NET, retries: 0 }, ...fakeClock() }).send(INPUT);
  assert.ok(!r2.error.message.includes('secret-key-1234'));
});

test('send는 throw하지 않는다', async () => {
  const weird = [
    async () => { throw null; },
    async () => { throw 'string'; },
    async () => ({ status: 200, headers: {}, body: undefined }),
    async () => ({ status: 204 }),
  ];
  for (const transport of weird) {
    const res = await createClient(TARGET, { transport, network: { ...NET, retries: 0 }, ...fakeClock() }).send(INPUT);
    assert.equal(res.ok, false);
    assert.ok(res.error.code);
  }
});
