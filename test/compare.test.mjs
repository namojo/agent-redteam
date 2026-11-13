import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runSuite, createMockTransport, compareReports, renderCompareMarkdown, ConfigError, MOCK_CANARY } from '../src/core/index.mjs';

const now = () => 0;
const mockTarget = (mode) => ({ provider: 'openai', url: `mock://${mode}/v1/chat/completions`, model: 'mock-agent' });
const report = (raw) => runSuite(normalizeConfig({ version: 2, oracles: { canary: MOCK_CANARY }, ...raw }).config, { transport: createMockTransport(), now });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('vulnerable → defend 차단률 1', async () => {
  const before = await report({ target: mockTarget('vulnerable'), attack: { transforms: ['base64'] } });
  const after = await report({ target: mockTarget('vulnerable'), attack: { transforms: ['base64'], defend: true } });
  const cmp = compareReports(before, after);
  assert.equal(cmp.blockRate, 1);
  assert.equal(cmp.fixed.length, before.cases.length);
  assert.deepEqual(cmp.regressed, []);
  assert.deepEqual(cmp.warnings, []);
  assert.equal(cmp.before.defend, false);
  assert.equal(cmp.after.defend, true);
  assert.equal(cmp.before.vulnerableCases, before.cases.length);
  assert.equal(cmp.byCategory.LLM01.blockRate, 1);
  assert.equal(cmp.byCategory.LLM01.ciOverlap, false, '100% vs 0% on 9 trials do not overlap');
  assert.deepEqual(Object.keys(cmp.byCategory), ['LLM01', 'LLM02', 'LLM06', 'LLM07']);
});

test('전 취약 0이면 blockRate null', async () => {
  const s = await report({ target: mockTarget('secure') });
  const cmp = compareReports(s, s);
  assert.equal(cmp.blockRate, null);
  assert.equal(cmp.byCategory.LLM07.blockRate, null);
});

test('regressed·fixed 목록', async () => {
  const before = await report({ target: mockTarget('vulnerable'), attack: { categories: ['LLM01'] } });
  const after = clone(before);
  after.cases[0].verdict = 'BLOCKED';
  const b2 = clone(before);
  b2.cases[1].verdict = 'BLOCKED';
  const cmp = compareReports(b2, after);
  assert.deepEqual(cmp.fixed, [before.cases[0].caseId]);
  assert.deepEqual(cmp.regressed, [before.cases[1].caseId]);
  assert.equal(cmp.blockRate, 0.25, 'G-4: before VULNERABLE (4) → after BLOCKED (1); a regression is reported in `regressed`, not netted');
});

test('케이스 집합 다르면 PROBE_SET_MISMATCH', async () => {
  const a = await report({ target: mockTarget('vulnerable'), attack: { categories: ['LLM01'] } });
  const b = await report({ target: mockTarget('vulnerable'), attack: { categories: ['LLM01'], transforms: ['rot13'] } });
  const cmp = compareReports(a, b);
  assert.ok(cmp.warnings.some((w) => w.code === 'PROBE_SET_MISMATCH'));
  assert.equal(cmp.onlyInBefore.length, 0);
  assert.equal(cmp.onlyInAfter.length, 4);
  const other = await report({ target: mockTarget('secure'), attack: { categories: ['LLM01'] } });
  assert.ok(compareReports(a, other).warnings.some((w) => w.code === 'TARGET_MISMATCH'));
});

test('ciOverlap 계산', async () => {
  const a = await report({ target: mockTarget('vulnerable'), attack: { probes: ['LLM01-override-ko'] } });
  const b = clone(a);
  b.cases[0].trials[0].verdict = 'BLOCKED';
  b.cases[0].verdict = 'BLOCKED';
  const cmp = compareReports(a, b);
  assert.equal(cmp.byCategory.LLM01.ciOverlap, true, 'n=1 intervals overlap');
  assert.equal(compareReports(a, a).byCategory.LLM01.ciOverlap, true);
});

test('스키마 버전 다르면 ConfigError', async () => {
  const a = await report({ target: mockTarget('secure'), attack: { probes: ['LLM01-override-ko'] } });
  const bad = { ...clone(a), schemaVersion: 2 };
  assert.throws(() => compareReports(a, bad), (e) => e instanceof ConfigError && e.code === 'SCHEMA_MISMATCH');
  assert.throws(() => compareReports({}, a), ConfigError);
});

test('renderCompareMarkdown 헤딩', async () => {
  const a = await report({ target: mockTarget('vulnerable'), attack: { probes: ['LLM01-override-ko'] } });
  const md = renderCompareMarkdown(compareReports(a, a));
  for (const h of ['# agent-redteam 폐루프 비교', '## 차단률', '## 고쳐진 케이스', '## 새로 뚫린 케이스', '## 경고']) assert.ok(md.split('\n').includes(h), h);
  assert.match(md, /차이를 단정할 수 없음/);
});
