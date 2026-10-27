/** 리포트 렌더링 — 콘솔 요약 + Markdown + JSON */
import { REG, enhLabel } from './engine.mjs';

const VLABEL = (r) => (r.error ? '오류' : r.verdict === 'VULNERABLE' ? '취약' : r.verdict === 'BLOCKED' ? '차단' : '미결');

// ANSI (TTY일 때만)
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => c('31', s), green = (s) => c('32', s), yellow = (s) => c('33', s), dim = (s) => c('90', s), bold = (s) => c('1', s);

export function renderConsole(rep) {
  const L = [];
  L.push('');
  L.push(bold('  agent-redteam · 모의 해킹 결과'));
  L.push(dim('  ─────────────────────────────────────────────'));
  L.push(`  대상        ${rep.url}`);
  L.push(`  방어(가드)  ${rep.defended ? 'ON' : 'OFF'}   LLM판정 ${rep.judge ? 'ON' : 'OFF'}   멀티턴 ${rep.multiturn ? 'ON' : 'OFF'}`);
  L.push(`  공격 변형   ${rep.transforms.length ? rep.transforms.map(enhLabel).join(', ') : '기본'}`);
  L.push('');
  for (const r of rep.results) {
    const v = VLABEL(r);
    const tag = r.enh && r.enh !== 'none' ? dim(` [${enhLabel(r.enh)}]`) : '';
    const mark = v === '취약' ? red('✗ 취약') : v === '차단' ? green('✓ 차단') : v === '오류' ? dim('· 오류') : yellow('? 미결');
    L.push(`  ${mark}  ${r.probe.cat.toUpperCase().padEnd(7)} ${r.probe.title}${tag}  ${dim(r.error || r.reason || '')}`);
  }
  L.push('');
  const s = rep.summary;
  L.push(dim('  ─────────────────────────────────────────────'));
  L.push(`  케이스 ${s.total}  ·  ${red('취약 ' + s.vuln)}  ·  ${green('차단 ' + s.blocked)}  ·  ${yellow('미결 ' + s.inconclusive)}${s.errors ? '  ·  오류 ' + s.errors : ''}`);
  L.push('  카테고리별 취약 — ' + `LLM01 ${rep.perCat.inject} · LLM02 ${rep.perCat.leak} · LLM06 ${rep.perCat.agency}`);
  L.push('');
  if (rep.gate.pass) L.push('  ' + green(bold(` ✓ PASS `)) + `  취약 ${s.vuln} ≤ 임계 ${rep.gate.threshold} — 배포 게이트 통과`);
  else L.push('  ' + red(bold(` ✗ FAIL `)) + `  취약 ${s.vuln} > 임계 ${rep.gate.threshold} — 배포 보류·수정 필요`);
  L.push('');
  return L.join('\n');
}

export function renderMarkdown(rep) {
  const s = rep.summary;
  const regMd = '## 규제 매핑 (국내)\n\n| OWASP | 공격 유형 | 관련 국내 규제 | 점검 포인트 |\n|---|---|---|---|\n' +
    REG.map((x) => `| ${x.owasp} | ${x.atk} | ${x.law.replace(/\|/g, '\\|')} | ${x.point} |`).join('\n') +
    '\n\n> 조문 번호는 참고용이며, 실제 적용 범위는 법무·컴플라이언스 검토가 필요합니다.\n';
  const rows = rep.results.map((r) => {
    return `| ${r.probe.cat} | ${(r.probe.title || '').replace(/\|/g, '\\|')} | ${r.enh && r.enh !== 'none' ? enhLabel(r.enh) : '기본'} | ${VLABEL(r)} | ${((r.error || r.reason || '').replace(/\|/g, '\\|'))} |`;
  }).join('\n');
  return [
    '# 에이전트 모의 해킹 리포트',
    '',
    `- 시각: ${rep.when}`,
    `- 대상: ${rep.url}`,
    `- 방어(가드): ${rep.defended ? 'ON' : 'OFF'} · LLM 판정: ${rep.judge ? 'ON' : 'OFF'} · 멀티턴: ${rep.multiturn ? 'ON' : 'OFF'}`,
    `- 공격 변형: ${rep.transforms.length ? rep.transforms.map(enhLabel).join(', ') : '기본'}`,
    `- **게이트: ${rep.gate.pass ? 'PASS' : 'FAIL'}** (취약 ${s.vuln} / 임계 ${rep.gate.threshold})`,
    `- 요약: 케이스 ${s.total} · 취약 ${s.vuln} · 차단 ${s.blocked} · 미결 ${s.inconclusive} · 오류 ${s.errors}`,
    `- 카테고리별 취약: LLM01 ${rep.perCat.inject} · LLM02 ${rep.perCat.leak} · LLM06 ${rep.perCat.agency}`,
    '',
    regMd,
    '## 케이스별 결과',
    '',
    '| 유형 | 프로브 | 변형 | 판정 | 근거 |',
    '|---|---|---|---|---|',
    rows,
    '',
    '> 프로브는 benign sentinel/카나리/국내 PII/거절/LLM-판정 방식이며, 멀티턴은 신뢰 구축 후 점증 공격입니다. "미결"은 사람이 응답을 직접 확인해야 합니다.',
    '',
  ].join('\n');
}
