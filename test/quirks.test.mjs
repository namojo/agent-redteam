import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runSuite, runPreflight, MOCK_CANARY } from '../src/core/index.mjs';
import { createNodeTransport } from '../src/node/transport.mjs';
import { startFakeOpenAI, QUIRK_NAMES } from './helpers/fake-openai.mjs';

const transport = createNodeTransport();
const sleep = async () => {};

async function withServer(opts, fn) {
  const server = await startFakeOpenAI(opts);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function config(server, { target = {}, attack = {}, oracles = {}, network = {}, ...rest } = {}) {
  return normalizeConfig({
    version: 2,
    authorized: true,
    target: { provider: 'openai', url: server.url, model: 'fake', ...target },
    attack: { multiturn: false, ...attack },
    oracles: { canary: MOCK_CANARY, ...oracles },
    network: { timeoutMs: 5000, retries: 0, ...network },
    ...rest,
  }, { env: rest.env || {} }).config;
}

const SENTINEL_PROBES = ['LLM01-override-ko', 'LLM01-roleplay', 'LLM06-consent'];

test('QUIRK_NAMES는 명세의 quirk 목록', () => {
  assert.deepEqual([...QUIRK_NAMES].sort(), ['delayMs', 'developerRole', 'emptyChoices', 'failStatus', 'malformed', 'noToolParser', 'rateLimit', 'rejectArrayContent', 'rejectEmptySystem', 'requireHeader', 'systemRole', 'think'].sort());
});

test('think full: secure에서 strip on → 전부 차단', () => withServer({ quirks: { think: 'full' } }, async (s) => {
  const r = await runSuite(config(s), { transport, sleep });
  assert.equal(r.summary.blocked, r.summary.cases);
  assert.ok(r.cases.every((c) => c.trials[0].turns[0].reasoningStripped));
  assert.equal(r.gate.pass, true);
}));

test('think full: strip off → sentinel 프로브 미결', () => withServer({ quirks: { think: 'full' } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: SENTINEL_PROBES }, oracles: { stripReasoning: false } }), { transport, sleep });
  for (const c of r.cases) {
    assert.equal(c.verdict, 'INCONCLUSIVE', c.caseId);
    assert.equal(c.source, 'sentinel');
  }
}));

test('think open-missing 처리', () => withServer({ quirks: { think: 'open-missing' } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: SENTINEL_PROBES } }), { transport, sleep });
  for (const c of r.cases) assert.equal(c.verdict, 'BLOCKED', c.caseId);
  assert.ok(!r.cases[0].trials[0].turns[0].response.includes('</think>'));
}));

test('developerRole reject + systemRole developer + systemPrompt 설정 → 오류 케이스·게이트 FAIL', () => withServer({ quirks: { developerRole: 'reject' } }, async (s) => {
  const r = await runSuite(config(s, { target: { systemRole: 'developer', systemPrompt: '지침 ' + MOCK_CANARY }, attack: { probes: ['LLM01-override-ko', 'LLM07-verbatim'] } }), { transport, sleep });
  assert.equal(r.summary.errors, 2);
  assert.match(r.cases[0].reason, /HTTP 400 .*unknown role: developer/);
  assert.equal(r.gate.pass, false);
  const ok = await runSuite(config(s, { target: { systemRole: 'developer' }, attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(ok.summary.errors, 0, 'empty system prompt → no developer message is sent');
}));

test('systemRole ignore·developerRole ignore → probe가 user-prefix 권장', () => withServer({ quirks: { systemRole: 'ignore', developerRole: 'ignore' } }, async (s) => {
  const target = config(s).target;
  const res = await runPreflight(target, { transport, network: { retries: 0, timeoutMs: 5000 } });
  const sr = res.checks.find((c) => c.id === 'system-role');
  assert.equal(sr.status, 'warn');
  assert.equal(res.recommended.systemRole, 'user-prefix');
  assert.equal(res.ok, true);
}));

test('rejectEmptySystem: system 비면 메시지 생략으로 통과', () => withServer({ quirks: { rejectEmptySystem: true } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(r.summary.errors, 0);
  assert.ok(!s.requests[0].body.messages.some((m) => m.role === 'system'));
}));

test('rejectArrayContent: 문자열 content로 통과', () => withServer({ quirks: { rejectArrayContent: true } }, async (s) => {
  const r = await runSuite(config(s, { target: { systemPrompt: 'S ' + MOCK_CANARY }, attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(r.summary.errors, 0);
  assert.ok(s.requests[0].body.messages.every((m) => typeof m.content === 'string'));
}));

test('requireHeader: ${ENV} 헤더로 통과, 누락 시 401 ERROR', () => withServer({ quirks: { requireHeader: { name: 'x-gateway-key', value: 'gw-test-value' } } }, async (s) => {
  const ok = normalizeConfig({
    version: 2, authorized: true,
    target: { provider: 'openai', url: s.url, model: 'fake', headers: { 'X-Gateway-Key': '${GW_KEY}' } },
    attack: { probes: ['LLM01-override-ko'] }, network: { retries: 0 },
  }, { env: { GW_KEY: 'gw-test-value' } }).config;
  const r = await runSuite(ok, { transport, sleep });
  assert.equal(r.summary.errors, 0);
  assert.ok(!JSON.stringify(r).includes('gw-test-value'));
  const bad = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(bad.cases[0].verdict, 'ERROR');
  assert.equal(bad.cases[0].trials[0].error.status, 401);
}));

test('noToolParser: 도구 프로브 미결(취약 아님) + probe tools warn', () => withServer({ mode: 'vulnerable', quirks: { noToolParser: true } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM06-other-user-tool', 'LLM06-destructive'] } }), { transport, sleep });
  for (const c of r.cases) assert.equal(c.verdict, 'INCONCLUSIVE', c.caseId);
  assert.ok(s.requests[0].body.tools.length === 3, 'tool definitions were sent');
  const pf = await runPreflight(config(s).target, { transport, network: { retries: 0, timeoutMs: 5000 } });
  const tools = pf.checks.find((c) => c.id === 'tools');
  assert.equal(tools.status, 'warn');
  assert.match(tools.suggestion, /tool-call-parser/);
}));

test('rateLimit 2 + retries 2 → 성공, retries 0 → ERROR', () => withServer({ quirks: { rateLimit: 2 } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] }, network: { retries: 2 } }), { transport, sleep });
  assert.equal(r.summary.errors, 0);
  assert.equal(s.requests.length, 3);
  s.setQuirks({ rateLimit: 2 });
  const r0 = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] }, network: { retries: 0 } }), { transport, sleep });
  assert.equal(r0.cases[0].verdict, 'ERROR');
  assert.equal(r0.cases[0].trials[0].error.status, 429);
}));

test('failStatus 500 → 게이트 FAIL', () => withServer({ quirks: { failStatus: 500 } }, async (s) => {
  const r = await runSuite(config(s), { transport, sleep });
  assert.equal(r.summary.errors, r.summary.cases);
  assert.equal(r.gate.pass, false);
}));

test('delayMs > timeoutMs → TIMEOUT', () => withServer({ quirks: { delayMs: 1500 } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] }, network: { timeoutMs: 1000, retries: 2 } }), { transport, sleep });
  assert.equal(r.cases[0].verdict, 'ERROR');
  assert.equal(r.cases[0].trials[0].error.code, 'TIMEOUT');
  assert.equal(s.requests.length, 1, 'timeouts are not retried');
}));

test('malformed → PARSE', () => withServer({ quirks: { malformed: true } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(r.cases[0].trials[0].error.code, 'PARSE');
}));

test('emptyChoices → PARSE', () => withServer({ quirks: { emptyChoices: true } }, async (s) => {
  const r = await runSuite(config(s, { attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  assert.equal(r.cases[0].trials[0].error.code, 'PARSE');
  assert.match(r.cases[0].reason, /choices/);
}));

test('기록된 요청에 temperature 0과 extraBody 존재', () => withServer({}, async (s) => {
  await runSuite(config(s, { target: { extraBody: { chat_template_kwargs: { enable_thinking: false } } }, attack: { probes: ['LLM01-override-ko'] } }), { transport, sleep });
  const body = s.requests[0].body;
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.model, 'fake');
  assert.equal(s.requests[0].headers['content-type'], 'application/json');
}));

test('anthropic 경로 왕복', () => withServer({ mode: 'vulnerable' }, async (s) => {
  const c = normalizeConfig({
    version: 2, authorized: true,
    target: { provider: 'anthropic', url: s.anthropicUrl, model: 'claude-test', apiKey: 'ak-test-1234', systemPrompt: '지침 ' + MOCK_CANARY },
    attack: { probes: ['LLM07-verbatim', 'LLM06-destructive'] }, oracles: { canary: MOCK_CANARY }, network: { retries: 0 },
  }).config;
  const r = await runSuite(c, { transport, sleep });
  assert.deepEqual(r.cases.map((x) => [x.caseId, x.verdict, x.source]), [['LLM06-destructive', 'VULNERABLE', 'tool'], ['LLM07-verbatim', 'VULNERABLE', 'canary']]);
  const req = s.requests[0];
  assert.equal(req.headers['x-api-key'], 'ak-test-1234');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(typeof req.body.system, 'string');
}));

test('legacy 경로 v1 설정 왕복', () => withServer({ mode: 'vulnerable' }, async (s) => {
  const n = normalizeConfig({
    url: s.legacyUrl, body: '{"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}', responsePath: 'reply', canary: MOCK_CANARY, multiturn: true, authorized: true,
  });
  const r = await runSuite(n.config, { transport, sleep, extraWarnings: n.warnings });
  assert.ok(r.summary.cases > 0);
  assert.equal(r.summary.vulnerable, r.summary.cases);
  assert.ok(r.warnings.some((w) => w.code === 'CONFIG_V1'));
  assert.ok(r.cases.some((c) => c.kind === 'crescendo'));
}));
