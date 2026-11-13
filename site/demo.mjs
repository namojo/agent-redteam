// Build-time demo numbers. Runs the real engine (src/core) against the in-process mock
// transport — no network — so every number on the landing page comes from code, not prose.
//   vulnerable: mock://vulnerable, default attack set, defend OFF
//   defended:   the same vulnerable mock with the guard prompt (attack.defend = true)
//   compare:    compareReports(vulnerable, defended)
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildDemo(root) {
  const core = await import(pathToFileURL(join(root, 'src', 'core', 'index.mjs')).href);
  const { PROBES, TRANSFORMS, CATEGORY_INFO, MOCK_CANARY, VERSION, normalizeConfig, runSuite, createMockTransport, compareReports } = core;

  const raw = (defend) => ({
    version: 2,
    authorized: true,
    target: { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'mock-agent' },
    attack: { transforms: [], multiturn: true, repeats: 1, defend },
    oracles: { canary: MOCK_CANARY },
  });
  const run = async (defend) => {
    const { config } = normalizeConfig(raw(defend), { env: {} });
    return runSuite(config, { transport: createMockTransport() });
  };
  const before = await run(false);
  const after = await run(true);
  const cmp = compareReports(before, after);

  const side = (r) => ({
    cases: r.summary.cases,
    vulnerable: r.summary.vulnerable,
    blocked: r.summary.blocked,
    inconclusive: r.summary.inconclusive,
    errors: r.summary.errors,
    gate: r.gate.status,
  });
  const categories = Object.keys(CATEGORY_INFO);
  const byCategory = Object.fromEntries(categories.map((c) => [c, PROBES.filter((p) => p.category === c).length]));
  const transforms = Object.values(TRANSFORMS).filter((t) => t.id !== 'none');
  const bMap = new Map(before.cases.map((c) => [c.caseId, c]));
  const denominator = cmp.comparableCases === undefined
    ? before.cases.filter((c) => c.verdict === 'VULNERABLE').length
    : before.cases.filter((c) => c.verdict === 'VULNERABLE' && !cmp.uncomparable.includes(c.caseId)).length;

  // demo.json — exactly the keys of the landing.json contract (brief 06)
  const data = {
    probes: {
      total: PROBES.length,
      singleTurn: PROBES.filter((p) => p.kind !== 'crescendo').length,
      crescendo: PROBES.filter((p) => p.kind === 'crescendo').length,
      byCategory,
    },
    transforms: { count: transforms.length, list: transforms.map((t) => t.label).join(', ') },
    vulnerable: side(before),
    defended: side(after),
    compare: {
      blockedRate: cmp.blockRate === null ? '—' : `${Math.round(cmp.blockRate * 100)}%`,
      fixed: cmp.fixed.length,
      denominator,
    },
  };

  // Page-only detail for the hero panel and compare block (rendered into HTML, not demo.json).
  const cases = after.cases.map((a) => {
    const b = bMap.get(a.caseId);
    return { caseId: a.caseId, category: a.category, title: a.title || (b && b.title) || a.caseId, before: b ? b.verdict : 'ERROR', after: a.verdict };
  });
  const detail = {
    version: VERSION,
    categories: categories.map((c) => ({ id: c, title: CATEGORY_INFO[c].title })),
    cases,
    before: { report: before, gate: before.gate },
    after: { report: after, gate: after.gate },
  };
  return { data, detail };
}

/** Resolve "demo.a.b" against data; returns undefined when the path is unknown or not a scalar. */
export function lookupDemo(data, path) {
  const parts = path.split('.');
  if (parts[0] !== 'demo') return undefined;
  let v = data;
  for (const p of parts.slice(1)) {
    if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p)) return undefined;
    v = v[p];
  }
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}
