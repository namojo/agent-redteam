import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../src/core/index.mjs';

const G = { maxVulnerable: 0, maxErrors: 0, failOnInconclusive: false };
const S = (o) => ({ cases: 10, vulnerable: 0, blocked: 10, inconclusive: 0, errors: 0, ...o });

test('취약 0·오류 0 PASS', () => {
  const g = evaluateGate(S(), G);
  assert.equal(g.pass, true);
  assert.equal(g.status, 'PASS');
  assert.deepEqual(g.reasons, []);
  assert.match(g.summaryText, /배포 게이트 통과/);
  assert.deepEqual(g.thresholds, G);
  assert.deepEqual(g.counts, { cases: 10, vulnerable: 0, errors: 0, inconclusive: 0, blocked: 10 });
});

test('취약 초과 FAIL', () => {
  const g = evaluateGate(S({ vulnerable: 1, blocked: 9 }), G);
  assert.equal(g.status, 'FAIL');
  assert.equal(g.reasons[0], '취약 케이스 1건이 허용치 0건을 초과했습니다.');
});

test('오류 전부 FAIL', () => {
  const g = evaluateGate(S({ blocked: 0, errors: 10 }), G);
  assert.equal(g.pass, false);
  assert.match(g.reasons[0], /오류 케이스 10건이 허용치 0건을 초과/);
});

test('케이스 0 FAIL', () => {
  const g = evaluateGate({ cases: 0, vulnerable: 0, blocked: 0, inconclusive: 0, errors: 0 }, G);
  assert.equal(g.pass, false);
  assert.match(g.reasons[0], /실행된 케이스가 없습니다/);
});

test('failOnInconclusive', () => {
  assert.equal(evaluateGate(S({ inconclusive: 2, blocked: 8 }), G).pass, true);
  const g = evaluateGate(S({ inconclusive: 2, blocked: 8 }), { ...G, failOnInconclusive: true });
  assert.equal(g.pass, false);
  assert.match(g.reasons[0], /미결 케이스 2건/);
});

test('maxVulnerable 2 경계(2 PASS, 3 FAIL)', () => {
  assert.equal(evaluateGate(S({ vulnerable: 2 }), { ...G, maxVulnerable: 2 }).pass, true);
  assert.equal(evaluateGate(S({ vulnerable: 3 }), { ...G, maxVulnerable: 2 }).pass, false);
});

test('사유를 모두 모은다', () => {
  const g = evaluateGate(S({ vulnerable: 2, errors: 1, inconclusive: 1 }), { ...G, failOnInconclusive: true });
  assert.equal(g.reasons.length, 3);
  assert.match(g.summaryText, / 외 2건$/);
});

test('summaryText 항상 채움', () => {
  for (const s of [S(), S({ vulnerable: 1 }), { cases: 0 }]) assert.ok(evaluateGate(s, G).summaryText.length > 0);
  assert.ok(evaluateGate(undefined, undefined).summaryText.length > 0);
});
