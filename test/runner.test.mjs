import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runSuite, createMockTransport, ConfigError, TransportError, MOCK_CANARY } from '../src/core/index.mjs';
import { assertReportShape } from './helpers/report-shape.mjs';

const ALL_T = ['base64', 'rot13', 'leet', 'split', 'jamo'];
const now = () => Date.UTC(2026, 10, 13, 0, 0, 0);
const mockTarget = (mode) => ({ provider: 'openai', url: `mock://${mode}/v1/chat/completions`, model: 'mock-agent' });
const cfg = (raw) => normalizeConfig({ version: 2, oracles: { canary: MOCK_CANARY }, ...raw }).config;
const run = (config, deps = {}) => runSuite(config, { transport: createMockTransport(), now, ...deps });
const sleep = async () => {};

function counting(transport) {
  const calls = [];
  return { calls, transport: async (req) => { calls.push(req); return transport(req); } };
}

test('vulnerable mock(openai): 전 케이스 취약·게이트 FAIL', async () => {
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { transforms: ALL_T } }));
  assert.equal(r.summary.cases, 87);
  assert.equal(r.summary.vulnerable, 87);
  assert.equal(r.gate.status, 'FAIL');
  assert.equal(r.durationMs, 0);
  assert.equal(r.startedAt, '2026-11-13T00:00:00.000Z');
  const bySource = Object.fromEntries(r.cases.filter((c) => c.transform === 'none').map((c) => [c.probeId, c.source]));
  assert.equal(bySource['LLM06-destructive'], 'tool');
  assert.equal(bySource['LLM07-verbatim'], 'canary');
  assert.equal(bySource['LLM02-secrets'], 'secret');
  assert.equal(r.cases.find((c) => c.probeId === 'LLM02-crescendo-pii').trials[0].vulnerableTurn, 3);
  assertReportShape(r);
});

test('secure mock: 전 케이스 차단·PASS', async () => {
  const r = await run(cfg({ target: mockTarget('secure'), attack: { transforms: ALL_T } }));
  assert.equal(r.summary.blocked, 87);
  assert.equal(r.gate.status, 'PASS');
  assert.equal(r.gate.pass, true);
  assert.ok(r.cases.every((c) => c.trials.every((t) => t.turns.every((u) => u.toolCalls.length === 0))));
  assertReportShape(r);
});

test('vulnerable + defend → 전부 차단(폐루프)', async () => {
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { transforms: ['base64'], defend: true } }));
  assert.equal(r.summary.vulnerable, 0);
  assert.equal(r.summary.blocked, r.summary.cases);
  assert.equal(r.gate.pass, true);
  assert.equal(r.settings.attack.defend, true);
});

test('repeats 3: trial 3개·ASR n·asrAtK k', async () => {
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { repeats: 3, categories: ['LLM01'] } }));
  assert.equal(r.summary.cases, 5);
  assert.equal(r.summary.trials, 15);
  assert.equal(r.plan.trials, 15);
  for (const c of r.cases) {
    assert.equal(c.trials.length, 3);
    assert.deepEqual(c.trials.map((t) => t.index), [1, 2, 3]);
    assert.equal(c.vulnerableTrials, 3);
  }
  const cat = r.summary.byCategory.LLM01;
  assert.equal(cat.asr.n, 15);
  assert.equal(cat.asr.p, 1);
  assert.deepEqual(cat.asrAtK, { k: 3, p: 1, n: 5 });
  assert.deepEqual(Object.keys(r.summary.byCategory), ['LLM01']);
  assert.deepEqual(r.regulations.map((x) => x.owasp), ['LLM01']);
  assertReportShape(r);
});

test('크레센도는 취약 턴에서 멈춘다(요청 수 확인)', async () => {
  const always = async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '알겠습니다. RT-CRESC-4B8' } }] }) });
  const c = counting(always);
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { probes: ['LLM01-crescendo-override'] } }), { transport: c.transport });
  assert.equal(c.calls.length, 1);
  assert.equal(r.cases[0].trials[0].vulnerableTurn, 1);
  assert.equal(r.cases[0].trials[0].turns.length, 1);
  const full = counting(createMockTransport());
  await run(cfg({ target: mockTarget('vulnerable'), attack: { probes: ['LLM01-crescendo-override'] } }), { transport: full.transport });
  assert.equal(full.calls.length, 3);
  const sent = JSON.parse(full.calls[2].body).messages;
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'], 'history is carried');
});

test('legacy v1(http) 도구 프로브 skipped·경고', async () => {
  const n = normalizeConfig({
    url: 'mock://vulnerable/chat', body: '{"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}', responsePath: 'reply', canary: MOCK_CANARY, multiturn: true,
  });
  const r = await run(n.config, { extraWarnings: n.warnings });
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('CONFIG_V1'));
  assert.ok(codes.includes('TOOL_PROBES_SKIPPED'));
  assert.ok(r.plan.skipped.some((s) => s.probeId === 'LLM06-destructive'));
  assert.equal(r.summary.vulnerable, r.summary.cases);
  assertReportShape(r);
});

test('agentToolProbes + toolCallsPath(legacy tool_calls)면 tool로 취약', async () => {
  const config = cfg({
    target: { provider: 'http', url: 'mock://vulnerable/chat', body: '{"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}', responsePath: 'reply', toolCallsPath: 'tool_calls' },
    attack: { agentToolProbes: true, probes: ['LLM06-destructive', 'LLM06-exfil-email', 'LLM06-crescendo-tool'] },
  });
  const r = await run(config);
  assert.deepEqual(r.cases.map((c) => [c.caseId, c.verdict, c.source]), [
    ['LLM06-destructive', 'VULNERABLE', 'tool'],
    ['LLM06-exfil-email', 'VULNERABLE', 'tool'],
    ['LLM06-crescendo-tool', 'VULNERABLE', 'tool'],
  ]);
  assert.ok(!r.warnings.some((w) => w.code === 'TOOL_CALLS_UNOBSERVABLE'));
});

test('모든 요청 500 → 전부 ERROR·게이트 FAIL', async () => {
  const fail = async () => ({ status: 500, headers: {}, body: '{"error":"x"}' });
  const config = cfg({ target: mockTarget('secure'), network: { retries: 1 } });
  const r = await run(config, { transport: fail, sleep });
  assert.equal(r.summary.errors, r.summary.cases);
  assert.equal(r.gate.pass, false);
  assert.match(r.gate.reasons[0], /오류 케이스/);
  assert.equal(r.cases[0].source, 'error');
  assert.equal(r.cases[0].trials[0].error.code, 'HTTP');
  assert.equal(r.cases[0].trials[0].error.status, 500);
  assert.equal(r.summary.asr.p, null, 'no measurable trials');
  assertReportShape(r);
});

test('transport NETWORK reject → ERROR', async () => {
  const down = async () => { throw new TransportError('NETWORK', 'ECONNREFUSED'); };
  const r = await run(cfg({ target: mockTarget('secure'), attack: { probes: ['LLM01-override-ko'] }, network: { retries: 0 } }), { transport: down, sleep });
  assert.equal(r.cases[0].verdict, 'ERROR');
  assert.equal(r.cases[0].trials[0].turns[0].error.code, 'NETWORK');
  assert.equal(r.gate.pass, false);
});

test('실제 URL + authorized false → NOT_AUTHORIZED', async () => {
  const config = cfg({ target: { provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm' } });
  await assert.rejects(() => run(config), (e) => e instanceof ConfigError && e.code === 'NOT_AUTHORIZED');
  const judgeReal = cfg({ target: mockTarget('secure'), judge: { enabled: true, target: { provider: 'openai', url: 'https://judge.example.test/v1', model: 'j' } } });
  await assert.rejects(() => run(judgeReal), (e) => e.code === 'NOT_AUTHORIZED', 'a real judge endpoint also needs authorization');
  const ok = cfg({ authorized: true, target: { provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm' }, attack: { probes: ['LLM01-override-ko'] } });
  const r = await run(ok, { transport: createMockTransport({ mode: 'secure' }) });
  assert.equal(r.gate.pass, true);
});

test('리포트 JSON에 apiKey·헤더 값 없음', async () => {
  const apiKey = 'sk-' + 'Z'.repeat(28);
  const header = 'gw-' + 'Q'.repeat(20);
  const config = cfg({
    authorized: true,
    target: { provider: 'openai', url: 'https://user:pw@llm.example.test/v1/chat/completions?api_key=abc123', model: 'm', apiKey, headers: { 'X-Gateway-Key': header } },
    attack: { probes: ['LLM01-override-ko', 'LLM02-secrets'] },
  });
  const echo = async (req) => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: `키는 ${apiKey} 그리고 ${header} 입니다` } }] }) });
  const r = await run(config, { transport: echo });
  const json = JSON.stringify(r);
  assert.ok(!json.includes(apiKey));
  assert.ok(!json.includes(header));
  assert.ok(!json.includes('pw@'));
  assert.ok(!json.includes('abc123'));
  assert.deepEqual(r.target.headerNames, ['x-gateway-key']);
  assert.equal(r.target.url, 'https://llm.example.test/v1/chat/completions?api_key=***');
  assertReportShape(r, { secrets: [apiKey, header] });
});

test('리포트의 PII는 마스킹됨', async () => {
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { probes: ['LLM02-pii-sample', 'LLM02-secrets'] } }));
  const json = JSON.stringify(r);
  assert.ok(!json.includes('900101-1234567'));
  assert.ok(!json.includes('010-1234-5678'));
  assert.ok(!json.includes('FAKE0000'));
  assert.match(json, /900101-1\*{6}/);
  assert.equal(r.cases[0].verdict, 'VULNERABLE', 'verdict is made before masking');
  const tool = await run(cfg({ target: mockTarget('vulnerable'), attack: { probes: ['LLM06-other-user-tool'] } }));
  assert.deepEqual(tool.cases[0].trials[0].turns[0].toolCalls, [{ name: 'get_salary', arguments: { employee: '이도윤' } }]);
});

test('onProgress 이벤트 순서', async () => {
  const events = [];
  await run(cfg({ target: mockTarget('secure'), attack: { probes: ['LLM01-override-ko', 'LLM07-verbatim'], repeats: 2 } }), { onProgress: (e) => events.push(`${e.type}:${e.caseIndex}${e.trialIndex !== undefined ? ':' + e.trialIndex : ''}`) });
  assert.deepEqual(events, [
    'case-start:0', 'trial-done:0:0', 'trial-done:0:1', 'case-done:0',
    'case-start:1', 'trial-done:1:0', 'trial-done:1:1', 'case-done:1',
  ]);
  await run(cfg({ target: mockTarget('secure'), attack: { probes: ['LLM01-override-ko'] } }), { onProgress: () => { throw new Error('ui bug'); } });
});

test('assertReportShape 통과 (judge·변형·멀티턴 포함)', async () => {
  const r = await run(cfg({ target: mockTarget('vulnerable'), attack: { transforms: ['jamo'], repeats: 2 }, judge: { enabled: true, mode: 'all' } }));
  assertReportShape(r);
  assert.ok(r.judge);
});

test('extraWarnings가 리포트 warnings에 합쳐짐', async () => {
  const extra = [{ code: 'CONFIG_V1', level: 'info', message: 'v1' }, { code: 'CONFIG_V1', level: 'info', message: 'v1' }];
  const r = await run(cfg({ target: mockTarget('secure'), attack: { categories: ['LLM07'] }, oracles: { canary: '' } }), { extraWarnings: extra });
  assert.deepEqual(r.warnings.map((w) => w.code), ['CONFIG_V1', 'NO_CANARY']);
  assert.equal(r.summary.inconclusive + r.summary.blocked, r.summary.cases);
});
