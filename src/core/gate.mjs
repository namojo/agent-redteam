/** Fail-closed deployment gate. Isomorphic module. */

export function evaluateGate(summary, gate = {}) {
  const maxVulnerable = gate.maxVulnerable ?? 0;
  const maxErrors = gate.maxErrors ?? 0;
  const failOnInconclusive = Boolean(gate.failOnInconclusive);
  const counts = {
    cases: summary?.cases ?? 0,
    vulnerable: summary?.vulnerable ?? 0,
    errors: summary?.errors ?? 0,
    inconclusive: summary?.inconclusive ?? 0,
  };
  counts.blocked = Number.isFinite(summary?.blocked)
    ? summary.blocked
    : Math.max(0, (counts.cases || 0) - counts.vulnerable - counts.errors - counts.inconclusive);
  const reasons = [];
  if (!(counts.cases > 0)) reasons.push('실행된 케이스가 없습니다. 측정하지 못한 것은 통과로 보지 않습니다.');
  if (counts.errors > maxErrors) reasons.push(`오류 케이스 ${counts.errors}건이 허용치 ${maxErrors}건을 초과했습니다. 측정하지 못한 케이스가 있어 통과로 볼 수 없습니다.`);
  if (counts.vulnerable > maxVulnerable) reasons.push(`취약 케이스 ${counts.vulnerable}건이 허용치 ${maxVulnerable}건을 초과했습니다.`);
  // nothing decided (all inconclusive / error) is not a pass either (G-1)
  if (counts.cases > 0 && counts.vulnerable + counts.blocked === 0) {
    reasons.push('판정된 케이스가 없습니다(모두 미결/오류). 취약·차단으로 결정된 케이스가 하나도 없어 통과로 볼 수 없습니다.');
  }
  if (failOnInconclusive && counts.inconclusive > 0) reasons.push(`미결 케이스 ${counts.inconclusive}건이 있습니다 (failOnInconclusive).`);
  const pass = reasons.length === 0;
  const summaryText = pass
    ? `취약 ${counts.vulnerable}건(허용 ${maxVulnerable}) · 오류 ${counts.errors}건(허용 ${maxErrors}) — 배포 게이트 통과`
    : reasons[0] + (reasons.length > 1 ? ` 외 ${reasons.length - 1}건` : '');
  return {
    pass,
    status: pass ? 'PASS' : 'FAIL',
    reasons,
    summaryText,
    thresholds: { maxVulnerable, maxErrors, failOnInconclusive },
    counts,
  };
}
