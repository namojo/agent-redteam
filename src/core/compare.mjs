/**
 * Closed-loop comparison of two reports (before/after defence). Isomorphic module.
 */
import { REPORT_SCHEMA_VERSION, CATEGORY_ORDER, CATEGORY_INFO } from './constants.mjs';
import { ConfigError } from './errors.mjs';
import { wilson } from './metrics.mjs';

function checkReport(r, name) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.cases) || !r.summary) {
    throw new ConfigError(`${name} 리포트 형식이 아닙니다`, [{ path: name, message: 'agent-redteam JSON 리포트가 아닙니다' }], 'SCHEMA_MISMATCH');
  }
  if (r.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ConfigError(`${name} 리포트 스키마 버전(${r.schemaVersion})이 ${REPORT_SCHEMA_VERSION}과 다릅니다`, [{ path: name + '.schemaVersion', message: '지원하지 않는 리포트 스키마' }], 'SCHEMA_MISMATCH');
  }
}

function trialAsr(cases) {
  const trials = cases.flatMap((c) => c.trials || []);
  const v = trials.filter((t) => t.verdict === 'VULNERABLE').length;
  const e = trials.filter((t) => t.verdict === 'ERROR').length;
  return wilson(v, trials.length - e);
}

function overlap(a, b) {
  if (a.low === null || b.low === null) return true;
  return a.low <= b.high && b.low <= a.high;
}

export function compareReports(before, after) {
  checkReport(before, 'before');
  checkReport(after, 'after');
  const bMap = new Map(before.cases.map((c) => [c.caseId, c]));
  const aMap = new Map(after.cases.map((c) => [c.caseId, c]));
  const common = [...bMap.keys()].filter((id) => aMap.has(id));
  const isV = (c) => c && c.verdict === 'VULNERABLE';
  const isE = (c) => !c || c.verdict === 'ERROR';
  // G-2: a case that is ERROR (or missing) in either report was not measured on both sides — "비교 불가".
  // It is excluded from the block-rate numerator and denominator and from fixed/regressed.
  const uncomparable = common.filter((id) => isE(bMap.get(id)) || isE(aMap.get(id)));
  const comparable = common.filter((id) => !uncomparable.includes(id));
  const rate = (ids) => {
    const bv = ids.filter((id) => isV(bMap.get(id))).length;
    const av = ids.filter((id) => isV(aMap.get(id))).length;
    return bv === 0 ? null : (bv - av) / bv;
  };

  const byCategory = {};
  for (const cat of CATEGORY_ORDER) {
    const bc = before.cases.filter((c) => c.category === cat);
    const ac = after.cases.filter((c) => c.category === cat);
    if (!bc.length && !ac.length) continue;
    const bAsr = trialAsr(bc);
    const aAsr = trialAsr(ac);
    byCategory[cat] = {
      title: CATEGORY_INFO[cat].title,
      before: { vulnerableCases: bc.filter(isV).length, cases: bc.length, asr: bAsr },
      after: { vulnerableCases: ac.filter(isV).length, cases: ac.length, asr: aAsr },
      blockRate: rate(comparable.filter((id) => bMap.get(id).category === cat)),
      uncomparable: uncomparable.filter((id) => bMap.get(id).category === cat).length,
      ciOverlap: overlap(bAsr, aAsr),
    };
  }

  const warnings = [];
  const onlyInBefore = [...bMap.keys()].filter((id) => !aMap.has(id));
  const onlyInAfter = [...aMap.keys()].filter((id) => !bMap.has(id));
  if (onlyInBefore.length || onlyInAfter.length) {
    warnings.push({ code: 'PROBE_SET_MISMATCH', level: 'warn', message: `두 리포트의 케이스 집합이 다릅니다 (전에만 ${onlyInBefore.length}건, 후에만 ${onlyInAfter.length}건). 차단률은 공통 케이스 ${common.length}건 기준입니다.` });
  }
  if (uncomparable.length) {
    warnings.push({ code: 'UNCOMPARABLE_CASES', level: 'warn', message: `전/후 중 한쪽이 오류인 케이스 ${uncomparable.length}건은 비교할 수 없어 차단률 계산에서 제외했습니다 (비교 가능 ${comparable.length}건).` });
  }
  const afterErrors = after.cases.filter((x) => x.verdict === 'ERROR').length;
  if (afterErrors > 0) {
    warnings.push({ code: 'AFTER_ERRORS', level: 'warn', message: `방어 후 리포트에 오류 케이스 ${afterErrors}건이 있습니다. 측정하지 못한 케이스가 있어 차단률을 신뢰할 수 없습니다.` });
  }
  const bt = before.target || {};
  const at = after.target || {};
  if (bt.url !== at.url || bt.model !== at.model || bt.provider !== at.provider) {
    warnings.push({ code: 'TARGET_MISMATCH', level: 'warn', message: '두 리포트의 대상(provider·url·model)이 다릅니다. 같은 대상의 방어 전/후인지 확인하십시오.' });
  }

  const side = (r) => ({
    vulnerableCases: r.summary.vulnerable ?? r.cases.filter(isV).length,
    cases: r.summary.cases ?? r.cases.length,
    errorCases: r.cases.filter((x) => x.verdict === 'ERROR').length,
    inconclusiveCases: r.cases.filter((x) => x.verdict === 'INCONCLUSIVE').length,
    finishedAt: r.finishedAt ?? null,
    defend: Boolean(r.settings && r.settings.attack && r.settings.attack.defend),
  });

  return {
    before: side(before),
    after: side(after),
    blockRate: rate(comparable),
    trustworthy: afterErrors === 0 && uncomparable.length === 0,
    comparableCases: comparable.length,
    uncomparable,
    byCategory,
    fixed: comparable.filter((id) => isV(bMap.get(id)) && !isV(aMap.get(id))),
    becameInconclusive: comparable.filter((id) => isV(bMap.get(id)) && aMap.get(id).verdict === 'INCONCLUSIVE'),
    regressed: comparable.filter((id) => !isV(bMap.get(id)) && isV(aMap.get(id))),
    onlyInBefore,
    onlyInAfter,
    warnings,
  };
}
