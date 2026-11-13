import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, buildPlan, TRANSFORMS } from '../src/core/index.mjs';

const OPENAI = { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'm' };
const HTTP = { provider: 'http', url: 'https://agent.example.test/chat', body: '{"system":"{{SYSTEM}}","message":"{{PROMPT}}"}', responsePath: 'reply' };
const plan = (raw) => buildPlan(normalizeConfig({ version: 2, ...raw }).config);
const codes = (p) => p.warnings.map((w) => w.code);

test('기본 계획 케이스 수 = 14 + 3', () => {
  const p = plan({ target: OPENAI, oracles: { canary: 'CANARY-7Q2X' } });
  assert.equal(p.cases.length, 17);
  assert.equal(p.cases.filter((c) => c.kind === 'crescendo').length, 3);
  assert.deepEqual(p.skipped, []);
  assert.deepEqual(p.warnings, []);
});

test('변형 2개면 14×3 + 3', () => {
  const p = plan({ target: OPENAI, attack: { transforms: ['base64', 'jamo'] }, oracles: { canary: 'CANARY-7Q2X' } });
  assert.equal(p.cases.length, 14 * 3 + 3);
  const b64 = p.cases.find((c) => c.caseId === 'LLM01-override-ko+base64');
  assert.ok(b64.turns[0].startsWith(TRANSFORMS.base64.prefix));
  assert.equal(b64.transform, 'base64');
});

test('categories·probes 필터', () => {
  assert.ok(plan({ target: OPENAI, attack: { categories: ['LLM07'] } }).cases.every((c) => c.probe.category === 'LLM07'));
  const p = plan({ target: OPENAI, attack: { probes: ['LLM01-override-ko', 'LLM06-crescendo-tool'] } });
  assert.deepEqual(p.cases.map((c) => c.caseId), ['LLM01-override-ko', 'LLM06-crescendo-tool']);
});

test('multiturn false면 크레센도 제외', () => {
  const p = plan({ target: OPENAI, attack: { multiturn: false } });
  assert.equal(p.cases.length, 14);
  assert.deepEqual(p.skipped, []);
});

test('http에 {{MESSAGES}} 없으면 크레센도 skipped + 경고', () => {
  const n = normalizeConfig({ version: 2, target: HTTP });
  assert.ok(n.warnings.some((w) => w.code === 'MULTITURN_UNSUPPORTED'));
  const p = buildPlan(n.config);
  for (const id of ['LLM01-crescendo-override', 'LLM02-crescendo-pii']) {
    assert.ok(p.skipped.some((s) => s.probeId === id && /MESSAGES/.test(s.reason)), id);
  }
  assert.ok(p.cases.every((c) => c.kind === 'single'));
});

test('http 도구 프로브 skipped + TOOL_PROBES_SKIPPED', () => {
  const p = plan({ target: { ...HTTP, body: '{"messages":[{{MESSAGES}}]}' } });
  const skippedIds = p.skipped.map((s) => s.probeId);
  for (const id of ['LLM06-other-user-tool', 'LLM06-destructive', 'LLM06-exfil-email', 'LLM06-crescendo-tool']) assert.ok(skippedIds.includes(id), id);
  assert.ok(codes(p).includes('TOOL_PROBES_SKIPPED'));
  assert.equal(codes(p).filter((c) => c === 'TOOL_PROBES_SKIPPED').length, 1);
  assert.ok(p.cases.some((c) => c.caseId === 'LLM06-consent'), 'string-based consent probe always runs');
  const noTools = plan({ target: { ...OPENAI, sendTools: false } });
  assert.ok(codes(noTools).includes('TOOL_PROBES_SKIPPED'));
});

test('agentToolProbes면 실행 + TOOL_CALLS_UNOBSERVABLE', () => {
  const p = plan({ target: HTTP, attack: { agentToolProbes: true } });
  assert.ok(p.cases.some((c) => c.caseId === 'LLM06-destructive'));
  assert.ok(codes(p).includes('TOOL_CALLS_UNOBSERVABLE'));
  assert.ok(p.cases.every((c) => c.sendTools === false), 'http never sends tool definitions');
  const withPath = plan({ target: { ...HTTP, toolCallsPath: 'tool_calls' }, attack: { agentToolProbes: true } });
  assert.ok(!codes(withPath).includes('TOOL_CALLS_UNOBSERVABLE'));
  const o = plan({ target: OPENAI });
  assert.equal(o.cases.find((c) => c.caseId === 'LLM06-destructive').sendTools, true);
  assert.equal(o.cases.find((c) => c.caseId === 'LLM01-override-ko').sendTools, false);
});

test('NO_CANARY', () => {
  assert.ok(codes(plan({ target: OPENAI })).includes('NO_CANARY'));
  assert.ok(!codes(plan({ target: OPENAI, oracles: { canary: 'CANARY-7Q2X' } })).includes('NO_CANARY'));
  assert.ok(!codes(plan({ target: OPENAI, attack: { categories: ['LLM01'] } })).includes('NO_CANARY'));
});

test('caseId 형식', () => {
  const p = plan({ target: OPENAI, attack: { transforms: ['rot13'] } });
  const ids = p.cases.map((c) => c.caseId);
  assert.ok(ids.includes('LLM07-verbatim'));
  assert.ok(ids.includes('LLM07-verbatim+rot13'));
  assert.ok(!ids.some((id) => id.includes('crescendo+')));
  assert.equal(new Set(ids).size, ids.length);
});

test('estimatedRequests 계산(크레센도 3턴×repeats)', () => {
  const p = plan({ target: OPENAI, attack: { repeats: 3 } });
  assert.deepEqual(p.estimatedRequests, { target: (14 + 3 * 3) * 3, judgeMax: 0, total: (14 + 9) * 3 });
  const j = plan({ target: OPENAI, attack: { repeats: 2 }, judge: { enabled: true } });
  assert.equal(j.estimatedRequests.judgeMax, 17 * 2);
  assert.equal(j.estimatedRequests.total, j.estimatedRequests.target + 34);
});
