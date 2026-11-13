/** Report contract checks (spec section 7.3). No side effects on import. */
import assert from 'node:assert/strict';

const VERDICTS = ['VULNERABLE', 'BLOCKED', 'INCONCLUSIVE', 'ERROR'];
const SOURCES = ['tool', 'canary', 'secret', 'pii', 'sentinel', 'refusal', 'judge', 'none', 'error'];

function checkWilson(w, where) {
  assert.ok(w && typeof w === 'object', `${where}: wilson object`);
  for (const k of ['p', 'low', 'high', 'n']) assert.ok(k in w, `${where}.${k}`);
}

export function assertReportShape(report, { secrets = [] } = {}) {
  const r = report;
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.tool.name, 'agent-redteam');
  for (const k of ['startedAt', 'finishedAt']) assert.ok(!Number.isNaN(Date.parse(r[k])), k);
  assert.equal(typeof r.durationMs, 'number');
  for (const k of ['provider', 'url', 'model', 'systemRole', 'headerNames', 'systemPromptSet', 'temperature', 'extraBodyKeys']) assert.ok(k in r.target, `target.${k}`);
  for (const k of ['attack', 'oracles', 'judge', 'gate', 'network']) assert.ok(r.settings[k], `settings.${k}`);
  assert.equal(typeof r.settings.oracles.canarySet, 'boolean');
  assert.ok(Array.isArray(r.plan.skipped));
  assert.equal(r.cases.length, r.plan.cases, 'cases.length === plan.cases');
  assert.equal(r.plan.trials, r.plan.cases * r.settings.attack.repeats);
  for (const c of r.cases) {
    for (const k of ['caseId', 'probeId', 'category', 'title', 'kind', 'transform', 'transformLabel', 'reason', 'vulnerableTrials', 'errorTrials']) assert.ok(k in c, `case.${k}`);
    assert.ok(VERDICTS.includes(c.verdict), c.caseId + ' verdict');
    assert.ok(SOURCES.includes(c.source), c.caseId + ' source');
    assert.equal(c.trials.length, r.settings.attack.repeats, c.caseId + ' trials');
    for (const t of c.trials) {
      assert.ok(VERDICTS.includes(t.verdict));
      assert.ok('judge' in t && 'error' in t && 'vulnerableTurn' in t);
      assert.ok(t.turns.length >= 1);
      for (const u of t.turns) {
        for (const k of ['turn', 'prompt', 'response', 'reasoningStripped', 'toolCalls', 'verdict', 'source', 'reason', 'evidence', 'latencyMs', 'error']) assert.ok(k in u, `turn.${k}`);
        assert.ok(u.prompt.length <= 1000 && u.response.length <= 2000);
      }
    }
  }
  const s = r.summary;
  assert.equal(s.vulnerable + s.blocked + s.inconclusive + s.errors, s.cases);
  assert.equal(s.cases, r.cases.length);
  checkWilson(s.asr, 'summary.asr');
  for (const [cat, x] of Object.entries(s.byCategory)) {
    checkWilson(x.asr, `byCategory.${cat}.asr`);
    assert.ok('k' in x.asrAtK && 'p' in x.asrAtK && 'n' in x.asrAtK);
  }
  assert.equal(r.gate.counts.cases, s.cases);
  assert.equal(r.gate.counts.vulnerable, s.vulnerable);
  assert.equal(r.gate.counts.errors, s.errors);
  assert.equal(r.gate.counts.inconclusive, s.inconclusive);
  assert.ok(['PASS', 'FAIL'].includes(r.gate.status));
  assert.equal(typeof r.gate.summaryText, 'string');
  assert.ok(r.gate.summaryText.length > 0);
  assert.ok(Array.isArray(r.warnings) && Array.isArray(r.regulations));
  for (const w of r.warnings) assert.ok(w.code && w.level && w.message);
  if (r.judge !== null) assert.equal(r.judge.enabled, true);
  // no NaN / undefined anywhere
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('NaN'));
  for (const sec of secrets) assert.ok(!json.includes(sec), 'secret leaked into report');
  return true;
}
