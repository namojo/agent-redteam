// Regression tests for QA round 2 (_workspace/04_qa_report.md R2-4): G-4, C-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, runSuite, createMockTransport, compareReports, renderCompareMarkdown, ConfigError, MOCK_CANARY } from '../src/core/index.mjs';
import { renderCompareConsole } from '../src/node/console-render.mjs';
import { main } from '../src/node/cli.mjs';
import { createMemoryIo } from './helpers/io.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const cfg = () => normalizeConfig({ version: 2, target: { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'm' }, oracles: { canary: MOCK_CANARY } }).config;
const emptyContent = async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });

// ── G-4: only after=BLOCKED counts as blocked ──
test('G4 방어 후 전부 빈 응답(미결) → 차단률 0%·고쳐짐 0·AFTER_INCONCLUSIVE·신뢰 불가', async () => {
  const before = await runSuite(cfg(), { transport: createMockTransport() });
  const after = await runSuite(cfg(), { transport: emptyContent });
  assert.equal(after.gate.pass, false);
  const cmp = compareReports(before, after);
  assert.equal(cmp.blockRate, 0, 'an all-empty after-run must not give 100%');
  assert.deepEqual(cmp.fixed, []);
  assert.equal(cmp.becameInconclusive.length, 17);
  assert.equal(cmp.comparableCases, 17, 'inconclusive cases stay comparable (denominator)');
  assert.equal(cmp.trustworthy, false);
  assert.ok(cmp.warnings.some((w) => w.code === 'AFTER_INCONCLUSIVE'));
  for (const cat of Object.values(cmp.byCategory)) assert.equal(cat.blockRate, 0);
  const md = renderCompareMarkdown(cmp);
  assert.match(md, /전체 차단률: \*\*0\.0%\*\*/);
  assert.ok(md.split('\n').includes('## 미결로 바뀐 케이스'));
  assert.match(md, /신뢰할 수 없습니다/);
  const con = renderCompareConsole(cmp);
  assert.match(con, /전체 차단률 0\.0%/);
  assert.match(con, /미결로 바뀐 케이스 17건/);
  assert.match(con, /신뢰할 수 없습니다/);
});

test('G4 일부만 미결: 분모에는 남고 분자에는 없다', async () => {
  const before = await runSuite(cfg(), { transport: createMockTransport() });
  const after = JSON.parse(JSON.stringify(before));
  after.cases.forEach((c, i) => { c.verdict = i < 2 ? 'INCONCLUSIVE' : 'BLOCKED'; });
  const cmp = compareReports(before, after);
  assert.equal(cmp.blockRate, 15 / 17);
  assert.equal(cmp.fixed.length, 15);
  assert.deepEqual(cmp.becameInconclusive, [before.cases[0].caseId, before.cases[1].caseId]);
  assert.ok(!cmp.fixed.includes(before.cases[0].caseId));
  assert.equal(cmp.trustworthy, false);
});

test('G4 방어 후 전부 차단이면 100%·신뢰 가능', async () => {
  const before = await runSuite(cfg(), { transport: createMockTransport() });
  const n = normalizeConfig({ version: 2, target: { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'm' }, oracles: { canary: MOCK_CANARY }, attack: { defend: true } }).config;
  const after = await runSuite(n, { transport: createMockTransport() });
  const cmp = compareReports(before, after);
  assert.equal(cmp.blockRate, 1);
  assert.equal(cmp.trustworthy, true);
  assert.deepEqual(cmp.becameInconclusive, []);
  assert.ok(!cmp.warnings.some((w) => w.code === 'AFTER_INCONCLUSIVE'));
});

// ── C-5: a disabled judge needs none of its ${ENV} variables ──
test('C5 judge off: judge.target의 ${ENV}가 없어도 정규화 성공, judge.target은 null', () => {
  const raw = JSON.parse(readFileSync(ROOT + 'config.example.json', 'utf8'));
  assert.equal(raw.judge.enabled, false);
  const { config } = normalizeConfig(raw, { env: { LLM_API_KEY: 'k1-xxxx', GATEWAY_KEY: 'g1-xxxx' } });
  assert.equal(config.judge.enabled, false);
  assert.equal(config.judge.target, null);
  assert.ok(!JSON.stringify(config).includes('${JUDGE_API_KEY}'));
});

test('C5 judge on: 같은 ${ENV} 누락은 여전히 설정 오류', () => {
  const raw = JSON.parse(readFileSync(ROOT + 'config.example.json', 'utf8'));
  raw.judge.enabled = true;
  assert.throws(() => normalizeConfig(raw, { env: { LLM_API_KEY: 'k1-xxxx', GATEWAY_KEY: 'g1-xxxx' } }),
    (e) => e instanceof ConfigError && e.errors.some((x) => x.path === 'judge.target.apiKey'));
  const ok = normalizeConfig(raw, { env: { LLM_API_KEY: 'k1-xxxx', GATEWAY_KEY: 'g1-xxxx', JUDGE_API_KEY: 'j1-xxxx' } });
  assert.equal(ok.config.judge.target.apiKey, 'j1-xxxx');
});

test('C5 judge off여도 형태 검증은 한다', () => {
  assert.throws(() => normalizeConfig({ version: 2, target: { provider: 'openai', url: 'mock://secure/v1', model: 'm' }, judge: { enabled: false, target: { provider: 'nope', url: 'ftp://x' } } }),
    (e) => e.errors.some((x) => x.path === 'judge.target.provider') && e.errors.some((x) => x.path === 'judge.target.url'));
});

test('C5 CLI: config.example.json + 문서대로 env 2개 → dry-run 종료 0, --judge면 종료 2', async () => {
  const env = { LLM_API_KEY: 'k1-xxxx', GATEWAY_KEY: 'g1-xxxx' };
  const off = createMemoryIo({ env });
  assert.equal(await main(['--config', ROOT + 'config.example.json', '--dry-run'], off.io), 0, off.stderr);
  const on = createMemoryIo({ env });
  assert.equal(await main(['--config', ROOT + 'config.example.json', '--dry-run', '--judge'], on.io), 2);
  assert.match(on.stderr, /JUDGE_API_KEY/);
});
