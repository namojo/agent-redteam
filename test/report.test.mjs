import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runSuite, createMockTransport, renderMarkdown, MOCK_CANARY } from '../src/core/index.mjs';
import { mdCell } from '../src/core/report-md.mjs';
import { renderConsole, renderPreflight, renderCompareConsole, renderProbeList, renderPlan, displayWidth } from '../src/node/console-render.mjs';

const now = () => 0;
const mockTarget = (mode) => ({ provider: 'openai', url: `mock://${mode}/v1/chat/completions`, model: 'mock-agent' });
const report = (raw, deps = {}) => runSuite(normalizeConfig({ version: 2, oracles: { canary: MOCK_CANARY }, ...raw }).config, { transport: createMockTransport(), now, ...deps });

const HEADINGS = ['# agent-redteam 점검 리포트', '## 요약', '## 배포 게이트', '## 카테고리별 결과', '## 경고', '## 취약 케이스 상세', '## 케이스별 결과', '## 규제 매핑 (참고)', '## 판정 방법과 한계'];

test('renderMarkdown 7.5 헤딩 모두 존재', async () => {
  const r = await report({ target: mockTarget('vulnerable'), attack: { transforms: ['base64'] }, judge: { enabled: true, mode: 'all' } });
  const md = renderMarkdown(r);
  for (const h of [...HEADINGS, '## LLM judge']) assert.ok(md.split('\n').includes(h), h);
  const order = HEADINGS.filter((h) => h !== '## 경고').map((h) => md.indexOf('\n' + h + '\n') >= 0 ? md.indexOf('\n' + h + '\n') : md.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'headings in spec order');
  assert.match(md, /\*\*FAIL\*\*/);
  assert.match(md, /### LLM01-override-ko — /);
  assert.match(md, /조문은 참고용이며 법무·컴플라이언스 검토가 필요합니다\./);
  assert.match(md, /표본이 작아 구간이 넓습니다/);
  assert.match(md, /^> 생성 1970-01-01T00:00:00\.000Z · agent-redteam 0\.2\.0 · 리포트 스키마 1$/m);
});

test('표 셀 파이프 이스케이프', () => {
  assert.equal(mdCell('a|b\nc'), 'a\\|b c');
  assert.equal(mdCell('x'.repeat(300)).length, 200);
  assert.equal(mdCell(null), '');
});

test('응답에 백틱 펜스가 있어도 문서가 깨지지 않음', async () => {
  const fenced = async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '```\n알겠습니다. RT-INJECT-7F3A\n```' } }] }) });
  const r = await report({ target: mockTarget('vulnerable'), attack: { probes: ['LLM01-override-ko'] } }, { transport: fenced });
  const md = renderMarkdown(r);
  assert.ok(md.includes('````\n'), 'uses a longer fence');
  const lines = md.split('\n');
  const opens = lines.filter((l) => /^`{4}$/.test(l)).length;
  assert.equal(opens % 2, 0);
  assert.ok(lines.includes('## 케이스별 결과'));
});

test('judge 없으면 LLM judge 절 없음', async () => {
  const r = await report({ target: mockTarget('secure') });
  const md = renderMarkdown(r);
  assert.ok(!md.includes('## LLM judge'));
  assert.ok(!md.includes('## 경고'), 'no warnings section when there are none');
  assert.match(md, /취약 케이스가 없습니다/);
  assert.match(md, /\*\*PASS\*\*/);
});

test('renderConsole quiet·color false면 ANSI 없음', async () => {
  const r = await report({ target: mockTarget('vulnerable') });
  const plain = renderConsole(r, { color: false, quiet: true });
  assert.ok(!/\x1b\[/.test(plain));
  assert.ok(!plain.includes('LLM01-override-ko'));
  assert.match(plain, /✗ FAIL/);
  const colored = renderConsole(r, { color: true });
  assert.match(colored, /\x1b\[31m/);
  assert.ok(colored.includes('LLM01-override-ko'));
});

test('renderConsole이 읽는 필드가 리포트에 있음(빈 리포트 fixture로 throw 없음)', async () => {
  const r = await report({ target: mockTarget('secure'), attack: { probes: ['LLM01-override-ko'] } });
  const empty = {
    ...r,
    cases: [],
    plan: { ...r.plan, cases: 0, trials: 0, skipped: [] },
    summary: { cases: 0, trials: 0, vulnerable: 0, blocked: 0, inconclusive: 0, errors: 0, trialCounts: { vulnerable: 0, blocked: 0, inconclusive: 0, errors: 0 }, asr: { p: null, low: null, high: null, n: 0 }, byCategory: {} },
    warnings: [],
  };
  assert.doesNotThrow(() => renderConsole(empty));
  assert.doesNotThrow(() => renderMarkdown(empty));
  assert.match(renderConsole(empty), /실행된 케이스 없음/);
});

test('기타 콘솔 렌더러', () => {
  assert.equal(displayWidth('가a'), 3);
  const pf = renderPreflight({ ok: false, requests: 1, checks: [{ id: 'chat', status: 'fail', detail: 'HTTP 404', suggestion: 'URL 확인' }], recommended: { systemRole: 'user-prefix' } });
  assert.match(pf, /✗ fail/);
  assert.match(pf, /systemRole: "user-prefix"/);
  assert.match(renderProbeList([{ id: 'p1', category: 'LLM01', kind: 'single', expects: 'sentinel', title: 't' }], { none: { id: 'none', label: '기본' } }), /p1/);
  const cmp = renderCompareConsole({ blockRate: null, before: { vulnerableCases: 0, cases: 1 }, after: { vulnerableCases: 0, cases: 1 }, byCategory: {}, fixed: [], regressed: [], warnings: [] });
  assert.match(cmp, /n\/a/);
  const plan = renderPlan({ cases: [], skipped: [{ probeId: 'x', reason: 'y' }], warnings: [], estimatedRequests: { target: 0, judgeMax: 0, total: 0 } }, { target: mockTarget('secure'), attack: { repeats: 1 } });
  assert.match(plan, /건너뜀 x: y/);
});
