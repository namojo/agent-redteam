// Cancellation (web console request B5): runSuite / runPreflight with an AbortSignal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runSuite, runPreflight, createMockTransport, createFetchTransport, MOCK_CANARY, TransportError } from '../src/core/index.mjs';
import { createNodeTransport } from '../src/node/transport.mjs';
import { startFakeOpenAI } from './helpers/fake-openai.mjs';

const cfg = (target, extra = {}) => normalizeConfig({ version: 2, authorized: true, target, oracles: { canary: MOCK_CANARY }, network: { retries: 2, timeoutMs: 10000 }, ...extra }).config;
const MOCK = { provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'm' };

async function expectAbort(promise) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'aborted run must reject');
  assert.equal(err.name, 'AbortError');
  assert.equal(err.code, 'ABORTED');
  return err;
}

test('mock transport: 3번째 케이스 시작 시 중단 → AbortError, 부분 리포트는 FAIL·aborted', async () => {
  const ctrl = new AbortController();
  const seen = [];
  const transport = createMockTransport();
  const counting = async (req) => { seen.push(req); return transport(req); };
  const err = await expectAbort(runSuite(cfg(MOCK), {
    transport: counting,
    signal: ctrl.signal,
    onProgress: (e) => { if (e.type === 'case-done' && e.caseIndex === 1) ctrl.abort(); },
  }));
  const r = err.report;
  assert.equal(r.aborted, true);
  assert.equal(r.cases.length, 2, 'only completed cases');
  assert.equal(r.plan.cases, 17);
  assert.equal(seen.length, 2, 'no request after abort');
  assert.ok(seen.every((q) => q.signal === ctrl.signal), 'signal travels on the request');
  assert.equal(r.gate.pass, false);
  assert.equal(r.gate.status, 'FAIL');
  assert.match(r.gate.reasons[0], /점검이 중단되었습니다 \(완료 2\/17 케이스\)/);
  assert.ok(r.warnings.some((w) => w.code === 'ABORTED'));
  assert.equal(r.summary.blocked, 2, 'completed cases are real results (would PASS on their own)');
});

test('이미 중단된 signal → 요청 0회·AbortError·FAIL', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let calls = 0;
  const err = await expectAbort(runSuite(cfg(MOCK), { transport: async (q) => { calls += 1; return createMockTransport()(q); }, signal: ctrl.signal }));
  assert.equal(calls, 0);
  assert.equal(err.report.cases.length, 0);
  assert.equal(err.report.gate.pass, false);
});

test('재시도 백오프 대기 중 중단 → 재시도하지 않음', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const flaky = async () => { calls += 1; setTimeout(() => ctrl.abort(), 5); return { status: 503, headers: {}, body: 'busy' }; };
  const t0 = Date.now();
  const err = await expectAbort(runSuite(cfg(MOCK, { network: { retries: 5, retryBaseDelayMs: 20000, timeoutMs: 10000 } }), { transport: flaky, signal: ctrl.signal }));
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 5000, 'the backoff wait ends on abort');
  assert.equal(err.report.gate.pass, false);
});

test('signal 없이 호출하면 기존 동작 그대로', async () => {
  const r = await runSuite(cfg(MOCK), { transport: createMockTransport() });
  assert.equal(r.gate.pass, true);
  assert.ok(!('aborted' in r));
});

test('fake 서버 + node transport: 응답 대기 중인 요청을 중단', async () => {
  const s = await startFakeOpenAI({ quirks: { delayMs: 3000 } });
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    const err = await expectAbort(runSuite(cfg({ provider: 'openai', url: s.url, model: 'm' }), { transport: createNodeTransport(), signal: ctrl.signal }));
    assert.ok(Date.now() - t0 < 2000, 'in-flight request aborted, not waited out');
    assert.equal(s.requests.length, 1);
    assert.equal(err.report.cases.length, 0);
    assert.equal(err.report.gate.pass, false);
  } finally {
    await s.close();
  }
});

test('fake 서버 + fetch transport(웹 경로): 진행 중 요청 중단', async () => {
  const s = await startFakeOpenAI({ quirks: { delayMs: 3000 } });
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    const err = await expectAbort(runSuite(cfg({ provider: 'openai', url: s.url, model: 'm' }), { transport: createFetchTransport(), signal: ctrl.signal }));
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(err.report.gate.pass, false);
  } finally {
    await s.close();
  }
});

test('transport 단위: 중단되면 TransportError ABORTED', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const req = { url: 'mock://secure/v1/chat/completions', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000, signal: ctrl.signal };
  await assert.rejects(() => createMockTransport()(req), (e) => e instanceof TransportError && e.code === 'ABORTED');
  await assert.rejects(() => createNodeTransport()({ ...req, url: 'http://127.0.0.1:9/x' }), (e) => e.code === 'ABORTED');
  await assert.rejects(() => createFetchTransport({ fetchImpl: async () => { throw new Error('should not be called'); } })({ ...req, url: 'http://127.0.0.1:9/x' }), (e) => e.code === 'ABORTED');
});

test('runPreflight도 signal을 받는다', async () => {
  const target = cfg({ provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'm' }).target;
  const ctrl = new AbortController();
  let calls = 0;
  const t = async (q) => { calls += 1; if (calls === 2) ctrl.abort(); return createMockTransport()(q); };
  await expectAbort(runPreflight(target, { transport: t, network: { retries: 0, timeoutMs: 1000 }, signal: ctrl.signal }));
  assert.equal(calls, 2, 'no request after abort');
  const ok = await runPreflight(target, { transport: createMockTransport(), network: { retries: 0, timeoutMs: 1000 } });
  assert.equal(ok.ok, true);
});
