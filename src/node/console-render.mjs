/**
 * Terminal renderers. Pure string builders (no I/O), color optional.
 */
import { VERSION, VERDICT_LABELS } from '../core/constants.mjs';
import { redact, sanitizeUrl, collectSecrets } from '../core/redaction.mjs';

const ANSI = { red: 31, green: 32, yellow: 33, gray: 90, bold: 1, cyan: 36 };
const paint = (color) => (code, s) => (color ? `\x1b[${ANSI[code]}m${s}\x1b[0m` : s);

/** Terminal display width (East Asian wide characters count as 2). */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x3130 && c <= 0x318f);
    w += wide ? 2 : 1;
  }
  return w;
}

export function pad(s, width) {
  const t = String(s ?? '');
  const w = displayWidth(t);
  return w >= width ? t : t + ' '.repeat(width - w);
}

export function truncate(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (displayWidth(t) <= max) return t;
  let out = '';
  let w = 0;
  for (const ch of t) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

const pct1 = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%');
const ci = (w) => (!w || w.p === null ? 'n/a' : `${pct1(w.p)} (${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)})`);
const RULE = '  ' + '─'.repeat(64);

const MARK = {
  VULNERABLE: ['✗', 'red'],
  BLOCKED: ['✓', 'green'],
  INCONCLUSIVE: ['?', 'yellow'],
  ERROR: ['·', 'gray'],
};

export function renderConsole(report, { color = false, quiet = false } = {}) {
  const c = paint(color);
  const r = report;
  const a = r.settings.attack;
  const L = [];
  L.push('');
  L.push(c('bold', `  agent-redteam ${r.tool?.version ?? VERSION} · 점검 결과`));
  L.push(`  대상   ${r.target.provider} · ${r.target.url}${r.target.model ? ' · ' + r.target.model : ''}`);
  L.push(`  구성   변형 ${a.transforms.length ? a.transforms.join(', ') : '없음'} · 멀티턴 ${a.multiturn ? 'ON' : 'OFF'} · 반복 ${a.repeats} · 방어 ${a.defend ? 'ON' : 'OFF'} · judge ${r.settings.judge.enabled ? r.settings.judge.mode : 'OFF'}`);
  L.push(RULE);
  if (!quiet) {
    const idW = Math.min(40, Math.max(8, ...r.cases.map((x) => displayWidth(x.caseId))));
    const titleW = Math.min(34, Math.max(8, ...r.cases.map((x) => displayWidth(x.title))));
    for (const x of r.cases) {
      const [mark, col] = MARK[x.verdict] || ['?', 'yellow'];
      const label = c(col, `${mark} ${pad(VERDICT_LABELS[x.verdict] || x.verdict, 4)}`);
      const why = x.verdict === 'ERROR' ? x.reason : x.evidence ? `${x.reason} · ${x.evidence}` : x.reason;
      L.push(`  ${label}  ${x.category}  ${pad(truncate(x.caseId, idW), idW)}  ${pad(truncate(x.title, titleW), titleW)}  ${truncate(why, 80)}`);
    }
    if (!r.cases.length) L.push('  (실행된 케이스 없음)');
    L.push(RULE);
  }
  const s = r.summary;
  L.push(`  케이스 ${s.cases} · ${c('red', '취약 ' + s.vulnerable)} · ${c('green', '차단 ' + s.blocked)} · ${c('yellow', '미결 ' + s.inconclusive)} · ${c('gray', '오류 ' + s.errors)}   (시도 ${s.trials})`);
  const cats = Object.entries(s.byCategory);
  if (cats.length) {
    L.push(`  ${pad('OWASP', 6)} ${pad('항목', 22)} ${pad('케이스', 6)} ${pad('취약', 5)} ASR (95% CI)`);
    for (const [cat, x] of cats) {
      L.push(`  ${pad(cat, 6)} ${pad(x.title, 22)} ${pad(String(x.cases), 6)} ${pad(String(x.vulnerableCases), 5)} ${ci(x.asr)}`);
    }
  }
  if (r.judge) {
    const j = r.judge;
    L.push(`  judge  ${j.mode} · 호출 ${j.calls} · 실패 ${j.failures} · 해소 ${j.resolved}${j.sameAsTarget ? ' · ⚠ 대상과 같은 엔드포인트' : ''}`);
    if (j.calibration) L.push(`         보정 κ ${j.calibration.kappa === null ? 'n/a' : j.calibration.kappa.toFixed(2)} · 정밀도 ${pct1(j.calibration.precision)} · 재현율 ${pct1(j.calibration.recall)} · n ${j.calibration.n}${j.calibration.needsHumanReview ? c('yellow', ' · 사람 검토 필요') : ''}`);
  }
  if (r.plan.skipped.length) L.push(`  건너뜀 ${r.plan.skipped.map((x) => x.probeId).join(', ')}`);
  for (const w of r.warnings) L.push(`  ${c('yellow', '경고')}   [${w.code}] ${w.message}`);
  const g = r.gate;
  L.push(g.pass ? c('green', `  ✓ PASS  ${g.summaryText}`) : c('red', `  ✗ FAIL  ${g.summaryText}`));
  if (!g.pass && g.reasons.length > 1) for (const reason of g.reasons.slice(1)) L.push(`          ${reason}`);
  L.push('');
  return L.join('\n');
}

export function renderPlan(plan, config, warnings = [], { color = false } = {}) {
  const c = paint(color);
  const L = [];
  L.push('');
  L.push(c('bold', `  agent-redteam ${VERSION} · 실행 계획 (dry-run, 요청 없음)`));
  L.push(`  대상   ${config.target.provider} · ${sanitizeUrl(config.target.url)}${config.target.model ? ' · ' + config.target.model : ''}`);
  L.push(RULE);
  for (const cs of plan.cases) L.push(`  ${pad(cs.probe.category, 6)} ${pad(cs.caseId, 36)} ${cs.kind === 'crescendo' ? `멀티턴 ${cs.turns.length}턴` : '단일'}${cs.sendTools ? ' · 도구 정의 전송' : ''}`);
  L.push(RULE);
  for (const s of plan.skipped) L.push(`  건너뜀 ${s.probeId}: ${s.reason}`);
  const e = plan.estimatedRequests;
  L.push(`  케이스 ${plan.cases.length} · 반복 ${config.attack.repeats} · 대상 요청 최대 ${e.target}회 · judge 최대 ${e.judgeMax}회 · 합계 ${e.total}회`);
  const all = [...warnings, ...plan.warnings].filter((w, i, arr) => arr.findIndex((x) => x.code === w.code && x.message === w.message) === i);
  for (const w of all) L.push(`  ${c('yellow', '경고')}   [${w.code}] ${w.message}`);
  L.push('');
  return redact(L.join('\n'), collectSecrets(config));
}

const PF = { ok: ['✓', 'green'], warn: ['!', 'yellow'], fail: ['✗', 'red'], skip: ['-', 'gray'] };

export function renderPreflight(result, { color = false, secrets = [] } = {}) {
  const c = paint(color);
  const L = [];
  L.push('');
  L.push(c('bold', `  agent-redteam ${VERSION} · 엔드포인트 사전 점검 (요청 ${result.requests}회)`));
  L.push(RULE);
  for (const ch of result.checks) {
    const [m, col] = PF[ch.status] || ['?', 'yellow'];
    L.push(`  ${c(col, `${m} ${pad(ch.status, 4)}`)}  ${pad(ch.id, 12)} ${truncate(ch.detail, 90)}`);
    if (ch.suggestion) L.push(`  ${' '.repeat(6)}  ${' '.repeat(12)} → ${ch.suggestion}`);
  }
  L.push(RULE);
  const rec = result.recommended || {};
  const recLines = [];
  if (rec.systemRole) recLines.push(`systemRole: "${rec.systemRole}"`);
  if (rec.stripReasoning) recLines.push('oracles.stripReasoning: true (기본값 유지)');
  if (rec.extraBodyHint) recLines.push(`extraBody 예: ${rec.extraBodyHint}`);
  if (recLines.length) {
    L.push('  권장 설정');
    for (const x of recLines) L.push(`    ${x}`);
  }
  L.push(result.ok ? c('green', '  ✓ 사전 점검 통과 (fail 없음)') : c('red', '  ✗ 사전 점검 실패 — fail 항목을 먼저 해결하십시오'));
  L.push('');
  return redact(L.join('\n'), secrets);
}

export function renderCompareConsole(cmp, { color = false } = {}) {
  const c = paint(color);
  const L = [];
  L.push('');
  L.push(c('bold', `  agent-redteam ${VERSION} · 폐루프 비교`));
  L.push(`  전체 차단률 ${pct1(cmp.blockRate)}  (취약 케이스 ${cmp.before.vulnerableCases}/${cmp.before.cases} → ${cmp.after.vulnerableCases}/${cmp.after.cases} · 비교 불가 ${(cmp.uncomparable || []).length}건)`);
  if (cmp.trustworthy === false) L.push(c('red', '  ✗ 오류·비교 불가·방어 후 미결 케이스가 있어 이 차단률을 신뢰할 수 없습니다'));
  L.push(RULE);
  for (const [cat, x] of Object.entries(cmp.byCategory)) {
    L.push(`  ${pad(cat, 6)} ${pad(x.title, 20)} 전 ${ci(x.before.asr)} → 후 ${ci(x.after.asr)} · 차단률 ${pct1(x.blockRate)}${x.ciOverlap ? c('yellow', ' · 차이를 단정할 수 없음') : ''}`);
  }
  L.push(RULE);
  L.push(`  고쳐진 케이스 ${cmp.fixed.length}건${cmp.fixed.length ? ': ' + truncate(cmp.fixed.join(', '), 100) : ''}`);
  if ((cmp.becameInconclusive || []).length) L.push(c('yellow', `  미결로 바뀐 케이스 ${cmp.becameInconclusive.length}건 (차단 미확인 — 차단률 분자에서 제외)`));
  L.push(`  새로 뚫린 케이스 ${cmp.regressed.length}건${cmp.regressed.length ? ': ' + truncate(cmp.regressed.join(', '), 100) : ''}`);
  for (const w of cmp.warnings) L.push(`  ${c('yellow', '경고')}   [${w.code}] ${w.message}`);
  L.push('');
  return L.join('\n');
}

export function renderProbeList(probes, transforms) {
  const L = [];
  L.push('');
  L.push(`  agent-redteam ${VERSION} · 프로브 ${probes.length}종`);
  L.push(RULE);
  for (const p of probes) {
    L.push(`  ${pad(p.category, 6)} ${pad(p.id, 28)} ${pad(p.kind === 'crescendo' ? '멀티턴' : '단일', 6)} ${pad(p.expects, 8)} ${p.title}${p.needsTools ? ' (도구 정의 필요)' : ''}`);
  }
  L.push(RULE);
  L.push('  변형');
  for (const t of Object.values(transforms)) L.push(`  ${pad(t.id, 8)} ${t.label}`);
  L.push('');
  return L.join('\n');
}
