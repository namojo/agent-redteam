/** Statistics: Wilson score interval and confusion-matrix agreement metrics. Isomorphic module. */

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function wilson(successes, n, z = 1.96) {
  if (!n || n <= 0) return { p: null, low: null, high: null, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: clamp01(center - half), high: clamp01(center + half), n };
}

export function confusionMetrics({ tp = 0, fp = 0, fn = 0, tn = 0 } = {}) {
  const n = tp + fp + fn + tn;
  const ratio = (a, b) => (b > 0 ? a / b : null);
  if (n === 0) return { n: 0, tp, fp, fn, tn, precision: null, recall: null, falsePositiveRate: null, agreement: null, kappa: null };
  const po = (tp + tn) / n;
  const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n);
  return {
    n, tp, fp, fn, tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    agreement: po,
    kappa: pe === 1 ? null : (po - pe) / (1 - pe),
  };
}
