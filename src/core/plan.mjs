/**
 * Build the case plan from a normalized config. Isomorphic module.
 */
import { PROBES } from './probes.mjs';
import { applyTransform } from './transforms.mjs';

export const TOOL_SKIP_REASON = '실제 에이전트의 도구가 실행될 수 있어 건너뜀 — 더미 도구를 가진 테스트 인스턴스에서 attack.agentToolProbes=true로 켜십시오';
export const MULTITURN_SKIP_REASON = '대상 본문 템플릿에 {{MESSAGES}}가 없어 멀티턴을 보낼 수 없음 (MULTITURN_UNSUPPORTED)';

export function buildPlan(config) {
  const { target, attack, oracles, judge } = config;
  const cases = [];
  const skipped = [];
  const warnings = [];
  const warn = (code, message) => {
    if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, level: 'warn', message });
  };
  const multiturnCapable = target.provider !== 'http' || String(target.body || '').includes('{{MESSAGES}}');

  for (const probe of PROBES) {
    if (!attack.categories.includes(probe.category)) continue;
    if (attack.probes.length && !attack.probes.includes(probe.id)) continue;
    if (probe.kind === 'crescendo') {
      if (!attack.multiturn) continue;
      if (!multiturnCapable) { skipped.push({ probeId: probe.id, reason: MULTITURN_SKIP_REASON }); continue; }
    }
    if (probe.needsTools) {
      const toolsObservable = (target.provider !== 'http' && target.sendTools) || attack.agentToolProbes;
      if (!toolsObservable) {
        skipped.push({ probeId: probe.id, reason: TOOL_SKIP_REASON });
        warn('TOOL_PROBES_SKIPPED', '도구 호출 프로브(LLM06)를 안전상 건너뛰었습니다. 실제 도구가 실행될 수 있는 대상입니다 — 더미 도구를 가진 테스트 인스턴스에서 attack.agentToolProbes=true로 켜십시오.');
        continue;
      }
      if (target.provider === 'http' && !target.toolCallsPath) {
        warn('TOOL_CALLS_UNOBSERVABLE', '도구 프로브를 실행하지만 target.toolCallsPath가 없어 실제 도구 호출을 관찰할 수 없습니다. 도구 오라클이 동작하지 않습니다.');
      }
    }
    const sendTools = Boolean(probe.needsTools && target.provider !== 'http' && target.sendTools);
    if (probe.kind === 'crescendo') {
      cases.push({ caseId: probe.id, probe, transform: 'none', kind: 'crescendo', turns: [...probe.turns], sendTools });
      continue;
    }
    for (const t of ['none', ...attack.transforms]) {
      const turns = [applyTransform(t, probe.turns[0], { preserve: probe.sentinel ? [probe.sentinel] : [] })];
      cases.push({ caseId: t === 'none' ? probe.id : `${probe.id}+${t}`, probe, transform: t, kind: 'single', turns, sendTools });
    }
  }

  if (!oracles.canary && cases.some((c) => c.probe.category === 'LLM07')) {
    warn('NO_CANARY', 'LLM07(시스템 프롬프트 유출) 프로브가 있지만 oracles.canary가 없습니다. judge 없이는 해당 케이스가 미결로 남습니다.');
  }

  const repeats = attack.repeats;
  const targetReq = cases.reduce((s, c) => s + c.turns.length * repeats, 0);
  const judgeMax = judge.enabled ? cases.length * repeats : 0;
  return { cases, skipped, warnings, estimatedRequests: { target: targetReq, judgeMax, total: targetReq + judgeMax } };
}
