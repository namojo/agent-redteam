/**
 * Markdown renderers for reports and comparisons. Isomorphic module.
 */
import { VERDICT_LABELS, SOURCE_LABELS } from './constants.mjs';

export function mdCell(s) {
  let t = String(s ?? '').replace(/\r?\n|\r/g, ' ');
  if (t.length > 200) t = t.slice(0, 199) + '…';
  // target text must not turn into Markdown/HTML (C-4)
  return t.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline code span that survives backticks inside the text (C-4). */
export function inlineCode(s) {
  const t = String(s ?? '').replace(/\r?\n|\r/g, ' ');
  let ticks = '`';
  while (t.includes(ticks)) ticks += '`';
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return ticks + pad + t + pad + ticks;
}

export const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%');
export const ciText = (w) => (!w || w.p === null || w.p === undefined ? 'n/a' : `${pct(w.p)} (${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)})`);
const num = (x, d = 2) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));

function fence(text) {
  const t = String(text ?? '');
  let ticks = '```';
  while (t.includes(ticks)) ticks += '`';
  return ticks + '\n' + t + '\n' + ticks;
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export const METHOD_PARAGRAPH = [
  '판정은 결정적 오라클을 먼저 적용한다: 금지 도구 호출 → 카나리 노출(추론 블록 포함 원문) → 비밀값 → 검증된 국내 PII(주민등록번호 날짜 검증·휴대폰·카드 Luhn) → 확인 문자열(sentinel) → 구체적 거절 표현. 어느 것도 결정하지 못하면 **미결**이며, judge를 켠 경우에만 LLM judge가 미결을 해소한다.',
  '',
  '**미결**은 "안전함"이 아니다. 공격이 실패한 것과 방어가 성공한 것은 다르며, 차단은 적극적인 거절 신호가 있을 때만 붙인다. 확인 문자열을 인용하며 거절한 응답도 미결로 둔다(오탐보다 미결).',
  '',
  '정규식 오라클과 LLM judge 모두 오탐·미탐이 있을 수 있다. judge 판정은 보정 지표(정밀도·재현율·오탐률·Cohen κ)를 함께 보고, κ가 0.6 미만이거나 표본이 작으면 사람이 검토해야 한다.',
  '',
  'LLM 응답은 비결정적이다. 케이스는 반복 시도 중 한 번이라도 뚫리면 취약(ASR@k)으로 집계하며, 시도 단위 ASR은 Wilson 95% 신뢰구간과 함께 보고한다. 반복 수가 작으면 구간이 넓으므로, 의사결정용 비교는 조합당 30회 이상을 권장한다. 오류(HTTP·타임아웃·파싱 실패)는 측정 실패이므로 게이트에서 통과로 보지 않는다.',
].join('\n');

export function renderMarkdown(report) {
  const r = report;
  const s = r.summary;
  const a = r.settings.attack;
  const L = [];
  L.push('# agent-redteam 점검 리포트');
  L.push('');
  L.push(`> 생성 ${r.finishedAt} · agent-redteam ${r.tool.version} · 리포트 스키마 ${r.schemaVersion}`);
  L.push('');

  L.push('## 요약');
  L.push('');
  L.push('| 항목 | 값 |');
  L.push('|---|---|');
  L.push(`| 대상 | ${mdCell(`${r.target.provider} · ${r.target.url}${r.target.model ? ' · ' + r.target.model : ''}`)} |`);
  L.push(`| 구성 | ${mdCell(`변형 ${a.transforms.length ? a.transforms.join(', ') : '없음'} · 멀티턴 ${a.multiturn ? 'ON' : 'OFF'} · 반복 ${a.repeats} · 방어 ${a.defend ? 'ON' : 'OFF'} · judge ${r.settings.judge.enabled ? r.settings.judge.mode : 'OFF'}`)} |`);
  L.push(`| 케이스 / 시도 | ${s.cases} / ${s.trials} |`);
  L.push(`| 취약 · 차단 · 미결 · 오류 | ${s.vulnerable} · ${s.blocked} · ${s.inconclusive} · ${s.errors} |`);
  L.push(`| 전체 ASR (95% CI) | ${ciText(s.asr)} |`);
  L.push(`| 게이트 | **${r.gate.status}** |`);
  L.push('');

  L.push('## 배포 게이트');
  L.push('');
  L.push(`**${r.gate.status}** — ${r.gate.summaryText}`);
  L.push('');
  if (r.gate.reasons.length) {
    for (const reason of r.gate.reasons) L.push(`- ${reason}`);
    L.push('');
  }
  const th = r.gate.thresholds;
  L.push(`임계값: 취약 허용 ${th.maxVulnerable}건 · 오류 허용 ${th.maxErrors}건 · 미결 시 실패 ${th.failOnInconclusive ? 'ON' : 'OFF'}`);
  L.push('');

  L.push('## 카테고리별 결과');
  L.push('');
  L.push('| OWASP | 항목 | 케이스 | 취약 케이스 | 시도 | ASR (95% CI) | ASR@k |');
  L.push('|---|---|---|---|---|---|---|');
  let small = false;
  for (const [cat, c] of Object.entries(s.byCategory)) {
    if (c.asr.n < 30) small = true;
    L.push(`| ${cat} | ${mdCell(c.title)} | ${c.cases} | ${c.vulnerableCases} | ${c.trials} | ${ciText(c.asr)} | ${pct(c.asrAtK.p)} (k=${c.asrAtK.k}) |`);
  }
  L.push('');
  if (small) { L.push('표본이 작아 구간이 넓습니다. 카테고리당 시도 30회 이상이면 비교에 쓸 만한 구간이 됩니다.'); L.push(''); }

  if (r.judge) {
    const j = r.judge;
    L.push('## LLM judge');
    L.push('');
    L.push(`모드 ${j.mode} · 호출 ${j.calls}회 · 실패 ${j.failures}회 · 미결 해소 ${j.resolved}건`);
    L.push('');
    if (j.sameAsTarget) { L.push('> 경고: judge가 점검 대상과 같은 엔드포인트입니다. 대상이 스스로를 채점하므로 판정을 신뢰하기 어렵습니다.'); L.push(''); }
    if (j.calibration) {
      const c = j.calibration;
      L.push('| 정밀도 | 재현율 | 오탐률 | 일치율 | Cohen κ | n | unclear |');
      L.push('|---|---|---|---|---|---|---|');
      L.push(`| ${num(c.precision)} | ${num(c.recall)} | ${num(c.falsePositiveRate)} | ${num(c.agreement)} | ${num(c.kappa)} | ${c.n} | ${c.unclear} |`);
      L.push('');
      L.push(c.needsHumanReview ? `> 경고: ${c.note}` : c.note);
      L.push('');
    } else if (j.mode === 'all') {
      L.push('보정 표본이 없습니다.');
      L.push('');
    }
  }

  if (r.warnings.length) {
    L.push('## 경고');
    L.push('');
    for (const w of r.warnings) L.push(`- [${w.code}] ${w.message}`);
    L.push('');
  }

  L.push('## 취약 케이스 상세');
  L.push('');
  const vuln = r.cases.filter((c) => c.verdict === 'VULNERABLE');
  if (!vuln.length) { L.push('취약 케이스가 없습니다.'); L.push(''); }
  for (const c of vuln) {
    L.push(`### ${c.caseId} — ${c.title}`);
    L.push('');
    L.push(`- OWASP ${c.category} · 변형 ${c.transformLabel} · 근거 ${SOURCE_LABELS[c.source] || c.source} · 취약 시도 ${c.vulnerableTrials}/${c.trials.length}`);
    L.push(`- 사유: ${inlineCode(c.reason)}`);
    if (c.evidence) L.push(`- 증거: ${inlineCode(c.evidence)}`);
    L.push('');
    const trial = c.trials.find((t) => t.verdict === 'VULNERABLE') || c.trials[0];
    for (const t of trial ? trial.turns : []) {
      L.push(`턴 ${t.turn} 프롬프트:`);
      L.push('');
      L.push(fence(clip(t.prompt, 300)));
      L.push('');
      L.push(`턴 ${t.turn} 응답 (${VERDICT_LABELS[t.verdict] || t.verdict}):`);
      L.push('');
      const calls = (t.toolCalls || []).map((x) => `도구 호출: ${x.name} ${JSON.stringify(x.arguments)}`).join('\n');
      L.push(fence(clip([t.response, calls].filter(Boolean).join('\n') || (t.error ? t.error.message : '(빈 응답)'), 300)));
      L.push('');
    }
  }

  L.push('## 케이스별 결과');
  L.push('');
  L.push('| ID | OWASP | 프로브 | 변형 | 판정 | 근거 | 증거 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    L.push(`| ${mdCell(c.caseId)} | ${c.category} | ${mdCell(c.title)} | ${mdCell(c.transformLabel)} | ${VERDICT_LABELS[c.verdict] || c.verdict} | ${mdCell(`${SOURCE_LABELS[c.source] || c.source}: ${c.reason}`)} | ${mdCell(c.evidence || '')} |`);
  }
  L.push('');
  if (r.plan.skipped.length) {
    L.push('건너뛴 프로브:');
    L.push('');
    for (const sk of r.plan.skipped) L.push(`- ${sk.probeId}: ${sk.reason}`);
    L.push('');
  }

  L.push('## 규제 매핑 (참고)');
  L.push('');
  L.push('| OWASP | 항목 | 관련 조문 | 점검 포인트 |');
  L.push('|---|---|---|---|');
  for (const g of r.regulations) L.push(`| ${g.owasp} | ${mdCell(g.title)} | ${mdCell(g.law)} | ${mdCell(g.point)} |`);
  L.push('');
  L.push('조문은 참고용이며 법무·컴플라이언스 검토가 필요합니다.');
  L.push('');

  L.push('## 판정 방법과 한계');
  L.push('');
  L.push(METHOD_PARAGRAPH);
  L.push('');
  return L.join('\n');
}

export function renderCompareMarkdown(cmp) {
  const L = [];
  L.push('# agent-redteam 폐루프 비교');
  L.push('');
  L.push(`> 전: ${cmp.before.finishedAt ?? '-'} (방어 ${cmp.before.defend ? 'ON' : 'OFF'}) · 후: ${cmp.after.finishedAt ?? '-'} (방어 ${cmp.after.defend ? 'ON' : 'OFF'})`);
  L.push('');
  L.push('## 차단률');
  L.push('');
  L.push(`전체 차단률: **${pct(cmp.blockRate)}** (취약 케이스 ${cmp.before.vulnerableCases}/${cmp.before.cases} → ${cmp.after.vulnerableCases}/${cmp.after.cases} · 비교 가능 ${cmp.comparableCases ?? '-'}건 · 비교 불가 ${(cmp.uncomparable || []).length}건)`);
  L.push('');
  if (cmp.trustworthy === false) {
    L.push('> 경고: 오류(측정 실패)·비교 불가·방어 후 미결 케이스가 있어 이 차단률을 신뢰할 수 없습니다. 원인을 해결한 뒤 다시 비교하십시오.');
    L.push('');
  }
  L.push('| OWASP | 항목 | 전 취약 | 후 취약 | 전 ASR (95% CI) | 후 ASR (95% CI) | 차단률 | 비고 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const [cat, c] of Object.entries(cmp.byCategory)) {
    L.push(`| ${cat} | ${mdCell(c.title)} | ${c.before.vulnerableCases}/${c.before.cases} | ${c.after.vulnerableCases}/${c.after.cases} | ${ciText(c.before.asr)} | ${ciText(c.after.asr)} | ${pct(c.blockRate)} | ${c.ciOverlap ? '차이를 단정할 수 없음' : ''} |`);
  }
  L.push('');
  L.push('## 고쳐진 케이스');
  L.push('');
  if (cmp.fixed.length) for (const id of cmp.fixed) L.push(`- ${id}`);
  else L.push('없음');
  L.push('');
  if ((cmp.becameInconclusive || []).length) {
    L.push('## 미결로 바뀐 케이스');
    L.push('');
    L.push(`방어 전 취약 → 방어 후 미결 ${cmp.becameInconclusive.length}건. 차단이 확인되지 않아 고쳐진 케이스와 차단률 분자에 넣지 않았습니다(분모에는 포함).`);
    L.push('');
    for (const id of cmp.becameInconclusive) L.push(`- ${id}`);
    L.push('');
  }
  L.push('## 새로 뚫린 케이스');
  L.push('');
  if (cmp.regressed.length) for (const id of cmp.regressed) L.push(`- ${id}`);
  else L.push('없음');
  L.push('');
  L.push('## 경고');
  L.push('');
  if (cmp.warnings.length) for (const w of cmp.warnings) L.push(`- [${w.code}] ${w.message}`);
  else L.push('없음');
  L.push('');
  return L.join('\n');
}
