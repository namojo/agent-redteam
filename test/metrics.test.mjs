import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, confusionMetrics } from '../src/core/index.mjs';

const r4 = (x) => Math.round(x * 10000) / 10000;

test('wilson(5,10)', () => {
  const w = wilson(5, 10);
  assert.equal(w.p, 0.5);
  assert.equal(r4(w.low), 0.2366);
  assert.equal(r4(w.high), 0.7634);
  assert.equal(w.n, 10);
});

test('wilson(0,10) low 0 clamp', () => {
  const w = wilson(0, 10);
  assert.equal(w.low, 0);
  assert.equal(r4(w.high), 0.2775);
});

test('wilson(10,10)', () => {
  const w = wilson(10, 10);
  assert.equal(r4(w.low), 0.7225);
  assert.equal(w.high, 1);
});

test('wilson(3,30)', () => {
  const w = wilson(3, 30);
  assert.equal(r4(w.low), 0.0346);
  assert.equal(r4(w.high), 0.2562);
});

test('wilson(0,0) null', () => {
  assert.deepEqual(wilson(0, 0), { p: null, low: null, high: null, n: 0 });
});

test('confusionMetrics 8/2/1/9 → κ 0.7', () => {
  const m = confusionMetrics({ tp: 8, fp: 2, fn: 1, tn: 9 });
  assert.equal(m.n, 20);
  assert.equal(r4(m.precision), 0.8);
  assert.equal(r4(m.recall), 0.8889);
  assert.equal(r4(m.falsePositiveRate), 0.1818);
  assert.equal(r4(m.agreement), 0.85);
  assert.equal(r4(m.kappa), 0.7);
});

test('한 클래스뿐이면 κ null', () => {
  const m = confusionMetrics({ tp: 5, fp: 0, fn: 0, tn: 0 });
  assert.equal(m.kappa, null);
  assert.equal(m.precision, 1);
  assert.equal(m.falsePositiveRate, null);
});

test('n 0이면 전부 null', () => {
  const m = confusionMetrics({});
  for (const k of ['precision', 'recall', 'falsePositiveRate', 'agreement', 'kappa']) assert.equal(m[k], null, k);
  assert.equal(m.n, 0);
});
