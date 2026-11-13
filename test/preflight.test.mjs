import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, createMockTransport, normalizeConfig } from '../src/core/index.mjs';

const target = (raw) => normalizeConfig({ version: 2, target: raw }).config.target;
const OPENAI = { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'mock-agent' };
const NET = { retries: 0, timeoutMs: 5000 };

function counting(t) {
  const calls = [];
  return { calls, transport: async (req) => { calls.push(req); return t(req); } };
}

test('mock vulnerable: 모든 검사 ok', async () => {
  const res = await runPreflight(target(OPENAI), { transport: createMockTransport(), network: NET });
  assert.deepEqual(res.checks.map((c) => [c.id, c.status]), [
    ['chat', 'ok'], ['reasoning', 'ok'], ['system-role', 'ok'], ['tools', 'ok'], ['json', 'ok'], ['multiturn', 'ok'],
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.recommended, {});
  assert.equal(res.requests, 5);
});

test('think quirk → reasoning warn + extraBody 힌트', async () => {
  const res = await runPreflight(target(OPENAI), { transport: createMockTransport({ quirks: { think: 'full' } }), network: NET });
  const r = res.checks.find((c) => c.id === 'reasoning');
  assert.equal(r.status, 'warn');
  assert.match(r.suggestion, /enable_thinking/);
  assert.equal(res.recommended.stripReasoning, true);
  assert.match(res.recommended.extraBodyHint, /chat_template_kwargs/);
  assert.equal(res.checks.find((c) => c.id === 'json').status, 'ok', 'extractJson strips reasoning');
});

test('http: {{SYSTEM}}·{{MESSAGES}} 없으면 skip, tools skip', async () => {
  const t = target({ provider: 'http', url: 'mock://vulnerable/chat', body: '{"message":"{{PROMPT}}"}', responsePath: 'reply' });
  const res = await runPreflight(t, { transport: createMockTransport(), network: NET });
  const st = Object.fromEntries(res.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(st, { chat: 'ok', reasoning: 'ok', 'system-role': 'skip', tools: 'skip', json: 'ok', multiturn: 'skip' });
  const full = target({ provider: 'http', url: 'mock://vulnerable/chat', body: '{"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}', responsePath: 'reply' });
  const r2 = await runPreflight(full, { transport: createMockTransport(), network: NET });
  assert.equal(r2.checks.find((c) => c.id === 'system-role').status, 'ok');
  assert.equal(r2.checks.find((c) => c.id === 'multiturn').status, 'ok');
});

test('chat 실패 → ok false, 나머지 skip', async () => {
  const c = counting(async () => ({ status: 404, headers: {}, body: 'not found' }));
  const res = await runPreflight(target(OPENAI), { transport: c.transport, network: NET });
  assert.equal(res.ok, false);
  assert.equal(res.checks[0].status, 'fail');
  assert.match(res.checks[0].detail, /HTTP: HTTP 404/);
  assert.ok(res.checks.slice(1).every((x) => x.status === 'skip'));
  assert.equal(c.calls.length, 1);
  const rp = await runPreflight(target({ provider: 'http', url: 'mock://vulnerable/chat', body: '{"m":"{{PROMPT}}"}', responsePath: 'wrong.path' }), { transport: createMockTransport(), network: NET });
  assert.match(rp.checks[0].suggestion, /responsePath/);
});

test('judgeTarget 검사 포함', async () => {
  const res = await runPreflight(target(OPENAI), {
    transport: createMockTransport(), network: NET,
    judgeTarget: target({ provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'judge' }),
  });
  const ids = res.checks.map((c) => c.id);
  assert.deepEqual(ids.slice(-2), ['judge.chat', 'judge.json']);
  assert.ok(res.checks.filter((c) => c.id.startsWith('judge.')).every((c) => c.status === 'ok'));
});

test('요청 수 상한 9', async () => {
  // every check fails softly → maximum fan-out (system-role tries all 3 roles)
  const c = counting(async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '그냥 답변' } }] }) }));
  const res = await runPreflight(target(OPENAI), { transport: c.transport, network: NET, judgeTarget: target(OPENAI) });
  assert.equal(c.calls.length, 9);
  assert.equal(res.requests, 9);
  assert.equal(res.checks.find((x) => x.id === 'system-role').status, 'warn');
  assert.equal(res.ok, true, 'warnings are not failures');
});
