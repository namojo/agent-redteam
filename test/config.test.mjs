import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, upgradeV1Config, applyOverrides, DEFAULTS, isMockUrl, ConfigError } from '../src/core/index.mjs';

const MIN = { version: 2, target: { provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm' } };
const norm = (raw, opts) => normalizeConfig(raw, opts);
const errorsOf = (raw, opts) => {
  try { normalizeConfig(raw, opts); } catch (e) { assert.ok(e instanceof ConfigError); return e.errors; }
  assert.fail('expected ConfigError');
};
const codes = (w) => w.map((x) => x.code);

test('최소 openai 설정의 정규화 결과 전체 deepEqual(2.2 shape)', () => {
  const { config, warnings } = norm(MIN);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, {
    version: 2,
    authorized: false,
    target: {
      provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm', apiKey: '', headers: {}, systemRole: 'system',
      systemPrompt: '', temperature: 0, maxTokens: null, extraBody: {}, sendTools: true, method: 'POST', body: '', responsePath: '', toolCallsPath: '',
    },
    attack: { categories: ['LLM01', 'LLM02', 'LLM06', 'LLM07'], probes: [], transforms: [], multiturn: true, repeats: 1, defend: false, agentToolProbes: false },
    oracles: { canary: '', stripReasoning: true, pii: ['rrn', 'mobile', 'card', 'secret'], forbiddenTools: [] },
    judge: { enabled: false, mode: 'fallback', target: null, sameAsTarget: true, maxResponseChars: 2000 },
    gate: { maxVulnerable: 0, maxErrors: 0, failOnInconclusive: false },
    network: { timeoutMs: 60000, retries: 2, retryBaseDelayMs: 500, rpm: 0, delayMs: 0, tls: { caFile: '', insecure: false } },
  });
});

test('DEFAULTS는 동결된 v2 원시 기본값', () => {
  assert.equal(DEFAULTS.version, 2);
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.target) && Object.isFrozen(DEFAULTS.network.tls));
  assert.equal(isMockUrl('mock://secure/v1/chat/completions'), true);
  assert.equal(isMockUrl('https://x'), false);
});

test('provider 누락 오류', () => {
  const errs = errorsOf({ version: 2, target: { url: 'https://x.example.test', model: 'm' } });
  assert.ok(errs.some((e) => e.path === 'target.provider'));
  assert.ok(errorsOf({ version: 2 }).some((e) => e.path === 'target'));
});

test('openai·anthropic model 필수', () => {
  assert.ok(errorsOf({ target: { provider: 'openai', url: 'https://x.example.test' } }).some((e) => e.path === 'target.model'));
  assert.ok(errorsOf({ target: { provider: 'anthropic', url: 'https://x.example.test' } }).some((e) => e.path === 'target.model'));
  const { config } = norm({ target: { provider: 'anthropic', url: 'https://x.example.test', model: 'c' } });
  assert.equal(config.target.maxTokens, 1024);
  assert.ok(errorsOf({ target: { provider: 'anthropic', url: 'https://x.example.test', model: 'c', maxTokens: null } }).some((e) => e.path === 'target.maxTokens'));
});

test('URL 스킴 검증과 mock 호스트', () => {
  assert.ok(errorsOf({ target: { provider: 'openai', url: 'ftp://x', model: 'm' } }).some((e) => e.path === 'target.url'));
  assert.ok(errorsOf({ target: { provider: 'openai', url: 'mock://other/v1', model: 'm' } }).some((e) => e.path === 'target.url'));
  assert.ok(errorsOf({ target: { provider: 'openai', model: 'm' } }).some((e) => e.path === 'target.url'));
  assert.equal(norm({ target: { provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'm' } }).config.target.url, 'mock://secure/v1/chat/completions');
});

test('${ENV} 치환과 누락 시 오류', () => {
  const raw = { target: { ...MIN.target, url: 'https://${HOST}/v1', apiKey: '${API_KEY}', headers: { 'X-Gw': 'pre-${GW}' } } };
  const { config } = norm(raw, { env: { HOST: 'llm.example.test', API_KEY: 'abc-123', GW: 'zz' } });
  assert.equal(config.target.url, 'https://llm.example.test/v1');
  assert.equal(config.target.apiKey, 'abc-123');
  assert.deepEqual(config.target.headers, { 'x-gw': 'pre-zz' });
  const errs = errorsOf(raw, { env: { HOST: 'h.example.test' } });
  assert.deepEqual(errs.map((e) => e.path).sort(), ['target.apiKey', 'target.headers.X-Gw']);
});

test('v1 평면 설정 키별 매핑 + CONFIG_V1', () => {
  const v1 = {
    url: 'http://127.0.0.1:8787/chat', method: 'post', body: '{"m":"{{PROMPT}}"}', responsePath: 'reply', key: 'kk-1234',
    canary: 'CANARY-7Q2X', transforms: ['base64'], defend: true, judge: true, threshold: 2, delayMs: 5, timeout: 5000, authorized: true,
  };
  const { raw, warnings } = upgradeV1Config(v1);
  assert.deepEqual(codes(warnings), ['CONFIG_V1']);
  assert.deepEqual(raw, {
    version: 2,
    authorized: true,
    target: { provider: 'http', url: v1.url, method: 'post', body: v1.body, responsePath: 'reply', apiKey: 'kk-1234' },
    attack: { multiturn: false, transforms: ['base64'], defend: true },
    oracles: { canary: 'CANARY-7Q2X' },
    judge: { enabled: true },
    gate: { maxVulnerable: 2 },
    network: { delayMs: 5, timeoutMs: 5000 },
  });
  const n = norm(v1);
  assert.equal(n.config.target.provider, 'http');
  assert.equal(n.config.target.method, 'POST');
  assert.equal(n.config.attack.multiturn, false);
  assert.equal(n.config.judge.sameAsTarget, true);
  assert.ok(codes(n.warnings).includes('CONFIG_V1'));
  assert.ok(codes(n.warnings).includes('JUDGE_SAME_AS_TARGET'));
  assert.ok(codes(upgradeV1Config({ url: 'http://x', preset: 'custom' }).warnings).includes('UNKNOWN_KEY'));
});

test('v1 headers JSON 문자열', () => {
  const { config } = norm({ url: 'http://127.0.0.1:1/chat', body: '{"m":"{{PROMPT}}"}', headers: '{"Content-Type":"application/json","X-K":"{{KEY}}"}' });
  assert.deepEqual(config.target.headers, { 'content-type': 'application/json', 'x-k': '{{KEY}}' });
  assert.throws(() => norm({ url: 'http://127.0.0.1:1/chat', body: '{}', headers: '{bad' }), ConfigError);
});

test('http body 템플릿 JSON 검증 오류', () => {
  const base = { target: { provider: 'http', url: 'https://agent.example.test/chat' } };
  assert.ok(errorsOf(base).some((e) => e.path === 'target.body'));
  assert.ok(errorsOf({ target: { ...base.target, body: '{"m": {{PROMPT}} }' } }).some((e) => e.path === 'target.body'));
  assert.ok(norm({ target: { ...base.target, body: '{"m":"{{PROMPT}}","h":[{{MESSAGES}}],"s":"{{SYSTEM}}","k":"{{KEY}}"}' } }));
  assert.ok(norm({ target: { ...base.target, body: 'q={{PROMPT}}', headers: { 'content-type': 'text/plain' } } }), 'non-JSON content-type skips JSON check');
  assert.ok(norm({ target: { ...base.target, method: 'GET' } }), 'GET needs no body');
});

test('모르는 키 UNKNOWN_KEY 경고', () => {
  const { warnings } = norm({ ...MIN, foo: 1, target: { ...MIN.target, bar: 2 }, attack: { baz: 3 } });
  const msgs = warnings.filter((w) => w.code === 'UNKNOWN_KEY').map((w) => w.message).join('\n');
  assert.match(msgs, /foo/);
  assert.match(msgs, /target\.bar/);
  assert.match(msgs, /attack\.baz/);
});

test('categories·probes·transforms 값 검증', () => {
  assert.ok(errorsOf({ ...MIN, attack: { categories: ['LLM03'] } }).some((e) => e.path === 'attack.categories'));
  assert.ok(errorsOf({ ...MIN, attack: { categories: [] } }).some((e) => e.path === 'attack.categories'));
  assert.ok(errorsOf({ ...MIN, attack: { probes: ['nope'] } }).some((e) => e.path === 'attack.probes'));
  assert.ok(errorsOf({ ...MIN, attack: { transforms: ['morse'] } }).some((e) => e.path === 'attack.transforms'));
  assert.deepEqual(norm({ ...MIN, attack: { transforms: ['none', 'base64', 'base64'] } }).config.attack.transforms, ['base64']);
});

test('repeats 범위', () => {
  assert.ok(errorsOf({ ...MIN, attack: { repeats: 0 } }).some((e) => e.path === 'attack.repeats'));
  assert.ok(errorsOf({ ...MIN, attack: { repeats: 101 } }).some((e) => e.path === 'attack.repeats'));
  assert.ok(errorsOf({ ...MIN, attack: { repeats: 1.5 } }).some((e) => e.path === 'attack.repeats'));
  assert.equal(norm({ ...MIN, attack: { repeats: 100 } }).config.attack.repeats, 100);
});

test('canary 6자 미만은 오류', () => {
  assert.ok(errorsOf({ ...MIN, oracles: { canary: 'ABC' } }).some((e) => e.path === 'oracles.canary'));
});

test('canary가 systemPrompt에 없으면 CANARY_NOT_IN_SYSTEM_PROMPT', () => {
  const w = norm({ ...MIN, target: { ...MIN.target, systemPrompt: '지침' }, oracles: { canary: 'CANARY-7Q2X' } }).warnings;
  assert.ok(codes(w).includes('CANARY_NOT_IN_SYSTEM_PROMPT'));
});

test('http 멀티턴·방어 슬롯 경고', () => {
  const w = norm({ target: { provider: 'http', url: 'https://a.example.test', body: '{"m":"{{PROMPT}}"}' }, attack: { defend: true } }).warnings;
  assert.ok(codes(w).includes('MULTITURN_UNSUPPORTED'));
  assert.ok(codes(w).includes('DEFEND_NO_SYSTEM_SLOT'));
});

test('insecure TLS 경고', () => {
  assert.ok(codes(norm({ ...MIN, network: { tls: { insecure: true } } }).warnings).includes('INSECURE_TLS'));
});

test('judge target 없으면 sameAsTarget + 경고', () => {
  const { config, warnings } = norm({ ...MIN, judge: { enabled: true } });
  assert.equal(config.judge.sameAsTarget, true);
  assert.equal(config.judge.target.url, MIN.target.url);
  assert.equal(config.judge.target.systemPrompt, '');
  assert.ok(codes(warnings).includes('JUDGE_SAME_AS_TARGET'));
});

test('judge 부분 target 기본값(maxTokens 512)', () => {
  const { config, warnings } = norm({
    ...MIN,
    target: { ...MIN.target, apiKey: 'target-key-1', headers: { 'x-gw': 'gw-secret' } },
    judge: { enabled: true, mode: 'all', target: { url: 'https://judge.example.test/v1/chat/completions', model: 'j' } },
  });
  const jt = config.judge.target;
  assert.equal(jt.provider, 'openai', 'provider inherited');
  assert.equal(jt.maxTokens, 512);
  assert.equal(jt.temperature, 0);
  assert.equal(jt.apiKey, '', 'credentials are not sent to a different endpoint');
  assert.deepEqual(jt.headers, {});
  assert.equal(config.judge.sameAsTarget, false);
  assert.ok(!codes(warnings).includes('JUDGE_SAME_AS_TARGET'));
  const same = norm({ ...MIN, target: { ...MIN.target, apiKey: 'target-key-1' }, judge: { enabled: true, target: { model: 'm' } } });
  assert.equal(same.config.judge.target.apiKey, 'target-key-1');
  assert.equal(same.config.judge.sameAsTarget, true);
});

test('applyOverrides 우선순위', () => {
  const raw = { version: 2, target: { provider: 'openai', url: 'a', model: 'm' }, attack: { repeats: 1 }, judge: { target: null } };
  const out = applyOverrides(raw, { 'target.url': 'b', 'attack.repeats': 3, 'judge.target.url': 'j', 'gate.maxErrors': undefined });
  assert.equal(out.target.url, 'b');
  assert.equal(out.target.model, 'm');
  assert.equal(out.attack.repeats, 3);
  assert.equal(out.judge.target.url, 'j');
  assert.ok(!('gate' in out));
  assert.equal(raw.target.url, 'a', 'input untouched');
});

test('caFile baseDir 결합', () => {
  assert.equal(norm({ ...MIN, network: { tls: { caFile: 'certs/ca.pem' } } }, { baseDir: '/etc/agent' }).config.network.tls.caFile, '/etc/agent/certs/ca.pem');
  assert.equal(norm({ ...MIN, network: { tls: { caFile: '/abs/ca.pem' } } }, { baseDir: '/etc/agent' }).config.network.tls.caFile, '/abs/ca.pem');
  assert.equal(norm({ ...MIN, network: { tls: { caFile: 'C:\\certs\\ca.pem' } } }, { baseDir: 'D:\\x' }).config.network.tls.caFile, 'C:\\certs\\ca.pem');
  assert.equal(norm({ ...MIN, network: { tls: { caFile: 'ca.pem' } } }).config.network.tls.caFile, 'ca.pem');
});

test('config.example.json·examples/*.config.json 정규화 성공(env 주입)', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = ['config.example.json', ...readdirSync(root + 'examples').filter((f) => f.endsWith('.config.json')).map((f) => 'examples/' + f)];
  assert.ok(files.length >= 3);
  const env = { LLM_API_KEY: 'k1-xxxx', GATEWAY_KEY: 'g1-xxxx', JUDGE_API_KEY: 'j1-xxxx' };
  for (const f of files) {
    const raw = JSON.parse(readFileSync(root + f, 'utf8'));
    const { config } = normalizeConfig(raw, { env });
    assert.equal(config.version, 2, f);
  }
  assert.throws(() => normalizeConfig(JSON.parse(readFileSync(root + 'config.example.json', 'utf8')), { env: {} }), ConfigError);
});

test('오류는 errors[]에 전부 모인다', () => {
  const errs = errorsOf({ version: 2, target: { provider: 'nope', url: 'x' }, attack: { repeats: 0, categories: ['X'] }, gate: { maxErrors: -1 }, network: { timeoutMs: 5 } });
  const paths = errs.map((e) => e.path);
  for (const p of ['target.provider', 'target.url', 'attack.repeats', 'attack.categories', 'gate.maxErrors', 'network.timeoutMs']) assert.ok(paths.includes(p), p);
});

test('forbiddenTools 정규화', () => {
  const { config } = norm({ ...MIN, oracles: { forbiddenTools: ['transfer_money', { name: 'send_email', argIncludes: 'external' }] } });
  assert.deepEqual(config.oracles.forbiddenTools, [{ name: 'transfer_money', argIncludes: null }, { name: 'send_email', argIncludes: 'external' }]);
  assert.ok(errorsOf({ ...MIN, oracles: { forbiddenTools: [42] } }).some((e) => e.path === 'oracles.forbiddenTools.0'));
});
