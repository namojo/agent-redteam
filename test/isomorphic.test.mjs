import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '../src/core/index.mjs';

const coreDir = fileURLToPath(new URL('../src/core/', import.meta.url));
const files = readdirSync(coreDir).filter((f) => f.endsWith('.mjs'));
const read = (f) => readFileSync(coreDir + f, 'utf8');

const SPEC_EXPORTS = `VERSION, REPORT_SCHEMA_VERSION, VERDICTS, SOURCES, VERDICT_LABELS, SOURCE_LABELS, CATEGORY_INFO,
ConfigError, TransportError,
PROBES, PROBE_TOOLS, GUARD_PROMPT, GUARD_MARKER, listProbes, getProbe,
TRANSFORMS, applyTransform, detectTransform, decodeTransform,
stripReasoning, detectRefusal, findCanary, findSecrets, findPii, matchToolRules, maskSensitive,
evaluateTurn, aggregateTrial, aggregateCase,
buildRequest, parseResponse, extractJson, getPath, composeSystem,
createClient,
normalizeConfig, upgradeV1Config, applyOverrides, DEFAULTS, isMockUrl,
buildPlan,
JUDGE_MARKER, buildJudgeMessages, parseJudgeOutput, buildCalibration,
wilson, confusionMetrics,
evaluateGate,
runSuite,
compareReports,
renderMarkdown, renderCompareMarkdown,
REGULATIONS,
mockAgent, mockOpenAIHandler, mockAnthropicHandler, mockLegacyHandler, MOCK_CANARY, MOCK_SYSTEM_PROMPT, MOCK_TOOLS,
createMockTransport, createFetchTransport,
runPreflight`.split(/[\s,]+/).filter(Boolean);

test('src/core의 어떤 파일도 node: 모듈을 import하지 않는다', () => {
  assert.ok(files.length >= 20);
  for (const f of files) {
    const src = read(f);
    assert.ok(!/from\s+['"]node:/.test(src), `${f}: static node: import`);
    assert.ok(!/import\(\s*['"]node:/.test(src), `${f}: dynamic node: import`);
  }
});

test('src/core는 Buffer·process·require를 쓰지 않는다', () => {
  for (const f of files) {
    const src = read(f);
    assert.ok(!/\brequire\(/.test(src), `${f}: require(`);
    assert.ok(!/\bBuffer\b/.test(src), `${f}: Buffer`);
    assert.ok(!/\bprocess\./.test(src), `${f}: process.`);
  }
});

test('src/core/index.mjs가 명세 3.1의 이름을 모두 export한다', () => {
  const missing = SPEC_EXPORTS.filter((n) => !(n in core));
  assert.deepEqual(missing, []);
  assert.equal(SPEC_EXPORTS.length, 63);
});

test('VERSION이 package.json version과 같다', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(core.VERSION, pkg.version);
});

test('package.json dependencies가 비어 있다', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.bin['agent-redteam'], 'src/cli.mjs');
});
