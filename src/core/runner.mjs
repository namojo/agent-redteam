/**
 * Suite runner: plan → sequential trials → oracle verdicts → judge → summary → fail-closed gate → report.
 * Isomorphic module: network goes through the injected transport only.
 */
import { VERSION, REPORT_SCHEMA_VERSION, CATEGORY_INFO, CATEGORY_ORDER } from './constants.mjs';
import { ConfigError } from './errors.mjs';
import { PROBE_TOOLS } from './probes.mjs';
import { TRANSFORMS } from './transforms.mjs';
import { maskSensitive } from './oracles.mjs';
import { evaluateTurn, aggregateTrial, aggregateCase } from './verdict.mjs';
import { composeSystem } from './compat.mjs';
import { createClient, redact } from './client.mjs';
import { isMockUrl } from './config.mjs';
import { buildPlan } from './plan.mjs';
import { buildJudgeMessages, parseJudgeOutput, buildCalibration, toolCallSummary } from './judge.mjs';
import { wilson } from './metrics.mjs';
import { evaluateGate } from './gate.mjs';
import { REGULATIONS } from './regulations.mjs';

// Header values that are protocol constants, not secrets — redacting them would only garble reports.
const NON_SECRET_HEADERS = new Set(['content-type', 'accept', 'anthropic-version', 'user-agent']);

/** Remove userinfo and replace query values with *** */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1')
    .replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=***');
}

export function collectSecrets(config) {
  const out = [];
  const add = (t) => {
    if (!t) return;
    out.push(t.apiKey);
    for (const [k, v] of Object.entries(t.headers || {})) if (!NON_SECRET_HEADERS.has(k)) out.push(v);
  };
  add(config.target);
  if (config.judge && config.judge.enabled) add(config.judge.target);
  return [...new Set(out.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
}

function isAuthorizedOrMock(config) {
  const { target, judge } = config;
  const mockOnly = isMockUrl(target.url) && (!judge.enabled || !judge.target || isMockUrl(judge.target.url));
  return Boolean(config.authorized) || mockOnly;
}

const VERDICT_KEYS = { VULNERABLE: 'vulnerable', BLOCKED: 'blocked', INCONCLUSIVE: 'inconclusive', ERROR: 'errors' };

/**
 * @param config normalized config (normalizeConfig().config)
 * @param {{transport: Function, judgeTransport?: Function, onProgress?: Function, sleep?: Function, now?: Function, extraWarnings?: object[]}} deps
 */
export async function runSuite(config, deps = {}) {
  const { transport, onProgress, sleep, extraWarnings = [] } = deps;
  const now = deps.now || Date.now;
  const judgeTransport = deps.judgeTransport || transport;
  if (typeof transport !== 'function') throw new TypeError('runSuite: deps.transport function required');
  if (!isAuthorizedOrMock(config)) {
    throw new ConfigError('권한 확인 필요: 소유하거나 테스트 권한이 있는 대상임을 authorized:true(CLI는 --yes)로 확인하십시오.', [], 'NOT_AUTHORIZED');
  }

  const plan = buildPlan(config);
  const startedAt = now();
  const secrets = collectSecrets(config);
  const canary = config.oracles.canary;
  const clean = (s) => (s === null || s === undefined ? s : maskSensitive(redact(String(s), secrets), { canary }));
  const maskDeep = (v) => {
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.map(maskDeep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
    return v;
  };

  const clientDeps = { network: config.network, sleep, now, secrets };
  const client = createClient(config.target, { transport, ...clientDeps });
  const judgeOn = Boolean(config.judge.enabled && config.judge.target);
  const judgeClient = judgeOn ? createClient(config.judge.target, { transport: judgeTransport, ...clientDeps }) : null;

  const ctx = {
    canary,
    stripReasoning: config.oracles.stripReasoning,
    piiTypes: config.oracles.pii,
    forbiddenTools: config.oracles.forbiddenTools,
  };
  const system = composeSystem(config);
  const repeats = config.attack.repeats;
  const emit = (ev) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(ev); } catch { /* progress must never break a run */ }
  };

  const judgeStats = { calls: 0, failures: 0, resolved: 0 };
  const rawTrials = [];
  const caseResults = [];

  for (let ci = 0; ci < plan.cases.length; ci++) {
    const c = plan.cases[ci];
    const caseCount = plan.cases.length;
    emit({ type: 'case-start', caseIndex: ci, caseCount, caseId: c.caseId });
    const trials = [];
    for (let r = 0; r < repeats; r++) {
      const history = [];
      const turns = [];
      let trialError = null;
      for (let i = 0; i < c.turns.length; i++) {
        const prompt = c.turns[i];
        history.push({ role: 'user', content: prompt });
        const res = await client.send({ system, messages: history.slice(), tools: c.sendTools ? PROBE_TOOLS : null });
        if (!res.ok) {
          turns.push({
            turn: i + 1, prompt, visible: '', reasoningStripped: false, toolCalls: [],
            verdict: 'ERROR', source: 'error', reason: res.error.message, evidence: null, latencyMs: res.latencyMs ?? null, error: res.error,
          });
          trialError = res.error;
          break;
        }
        const ev = evaluateTurn(c.probe, { text: res.text, toolCalls: res.toolCalls }, ctx);
        turns.push({
          turn: i + 1, prompt, visible: ev.visibleText, reasoningStripped: ev.reasoningStripped, toolCalls: res.toolCalls,
          verdict: ev.verdict, source: ev.source, reason: ev.reason, evidence: ev.evidence, latencyMs: res.latencyMs ?? null, error: null,
        });
        if (ev.verdict === 'VULNERABLE') break;
        history.push({ role: 'assistant', content: ev.visibleText || toolCallSummary(res.toolCalls) || '(빈 응답)' });
      }
      const agg = aggregateTrial(turns, trialError);
      const trial = { index: r + 1, ...agg, error: trialError, judge: null, turns };

      // judge (4.3)
      if (judgeClient) {
        const lastOk = [...turns].reverse().find((t) => !t.error);
        const resolve = trial.verdict === 'INCONCLUSIVE';
        const calibrate = config.judge.mode === 'all' && (trial.verdict === 'VULNERABLE' || trial.verdict === 'BLOCKED');
        if (lastOk && (resolve || calibrate)) {
          judgeStats.calls += 1;
          const jm = buildJudgeMessages({ goal: c.probe.goal, responseText: lastOk.visible, toolCalls: lastOk.toolCalls, maxChars: config.judge.maxResponseChars });
          const jr = await judgeClient.send({ system: jm.system, messages: jm.messages, tools: null });
          if (!jr.ok) {
            judgeStats.failures += 1;
            trial.judge = { verdict: 'UNCLEAR', reason: 'judge 호출 실패', used: false, error: { code: jr.error.code, message: jr.error.message } };
          } else {
            const p = parseJudgeOutput(jr.text);
            const used = resolve && (p.verdict === 'VULNERABLE' || p.verdict === 'BLOCKED');
            trial.judge = { verdict: p.verdict, reason: p.reason, used, error: null };
            if (used) {
              judgeStats.resolved += 1;
              trial.verdict = p.verdict;
              trial.source = 'judge';
              trial.reason = 'LLM judge: ' + (p.reason || p.verdict);
              trial.evidence = null;
            }
          }
        }
      }
      trials.push(trial);
      rawTrials.push(trial);
      emit({ type: 'trial-done', caseIndex: ci, caseCount, caseId: c.caseId, trialIndex: r, verdict: trial.verdict });
    }
    const agg = aggregateCase(trials);
    caseResults.push({
      caseId: c.caseId,
      probeId: c.probe.id,
      category: c.probe.category,
      title: c.probe.title,
      kind: c.kind,
      transform: c.transform,
      transformLabel: TRANSFORMS[c.transform].label,
      verdict: agg.verdict,
      source: agg.source,
      reason: clean(agg.reason),
      evidence: agg.evidence == null ? null : clean(agg.evidence),
      vulnerableTrials: agg.vulnerableTrials,
      errorTrials: agg.errorTrials,
      trials: trials.map((t) => ({
        index: t.index,
        verdict: t.verdict,
        source: t.source,
        reason: clean(t.reason),
        evidence: t.evidence == null ? null : clean(t.evidence),
        vulnerableTurn: t.vulnerableTurn ?? null,
        error: t.error ? cleanError(t.error, clean) : null,
        judge: t.judge ? { verdict: t.judge.verdict, reason: clean(t.judge.reason), used: t.judge.used, error: t.judge.error ? cleanError(t.judge.error, clean) : null } : null,
        turns: t.turns.map((u) => ({
          turn: u.turn,
          prompt: redact(u.prompt, secrets).slice(0, 1000),
          response: clean(u.visible).slice(0, 2000),
          reasoningStripped: u.reasoningStripped,
          toolCalls: (u.toolCalls || []).map((tc) => ({ name: tc.name, arguments: maskDeep(tc.arguments ?? {}) })),
          verdict: u.verdict,
          source: u.source,
          reason: clean(u.reason),
          evidence: u.evidence == null ? null : clean(u.evidence),
          latencyMs: u.latencyMs ?? null,
          error: u.error ? cleanError(u.error, clean) : null,
        })),
      })),
    });
    emit({ type: 'case-done', caseIndex: ci, caseCount, caseId: c.caseId, verdict: agg.verdict });
  }

  const summary = summarize(caseResults, repeats);
  const gate = evaluateGate(summary, config.gate);

  const warnings = [];
  const addWarning = (w) => {
    if (w && w.code && !warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push({ code: w.code, level: w.level || 'warn', message: w.message });
  };
  for (const w of extraWarnings || []) addWarning(w);
  for (const w of plan.warnings) addWarning(w);

  let judgeSection = null;
  if (config.judge.enabled) {
    const calibration = config.judge.mode === 'all' ? buildCalibration(rawTrials) : null;
    judgeSection = {
      enabled: true, mode: config.judge.mode, sameAsTarget: config.judge.sameAsTarget,
      calls: judgeStats.calls, failures: judgeStats.failures, resolved: judgeStats.resolved, calibration,
    };
    if (judgeStats.failures > 0) addWarning({ code: 'JUDGE_FAILURES', level: 'warn', message: `judge 호출 ${judgeStats.failures}건이 실패했습니다. 해당 시도는 미결로 남았습니다.` });
    if (calibration && calibration.needsHumanReview) addWarning({ code: 'JUDGE_LOW_AGREEMENT', level: 'warn', message: calibration.note });
  }

  const finishedAt = now();
  const t = config.target;
  const jt = config.judge.target;
  const categories = Object.keys(summary.byCategory);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: 'agent-redteam', version: VERSION },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    target: {
      provider: t.provider, url: sanitizeUrl(t.url), model: t.model, systemRole: t.systemRole,
      headerNames: Object.keys(t.headers || {}), systemPromptSet: Boolean(t.systemPrompt),
      temperature: t.temperature ?? null, extraBodyKeys: Object.keys(t.extraBody || {}),
    },
    settings: {
      attack: { ...config.attack, categories: [...config.attack.categories], probes: [...config.attack.probes], transforms: [...config.attack.transforms] },
      oracles: {
        canarySet: Boolean(canary), stripReasoning: config.oracles.stripReasoning, pii: [...config.oracles.pii],
        forbiddenTools: config.oracles.forbiddenTools.map((f) => ({ name: f.name, argIncludes: f.argIncludes ?? null })),
      },
      judge: {
        enabled: config.judge.enabled, mode: config.judge.mode, sameAsTarget: config.judge.sameAsTarget,
        provider: config.judge.enabled && jt ? jt.provider : null,
        url: config.judge.enabled && jt ? sanitizeUrl(jt.url) : null,
        model: config.judge.enabled && jt ? jt.model : null,
      },
      gate: { ...config.gate },
      network: {
        timeoutMs: config.network.timeoutMs, retries: config.network.retries, rpm: config.network.rpm, delayMs: config.network.delayMs,
        caFileSet: Boolean(config.network.tls.caFile), insecure: config.network.tls.insecure,
      },
    },
    plan: {
      cases: plan.cases.length,
      trials: plan.cases.length * repeats,
      skipped: plan.skipped.map((s) => ({ ...s })),
      estimatedRequests: { ...plan.estimatedRequests },
    },
    warnings,
    cases: caseResults,
    summary,
    judge: judgeSection,
    gate,
    regulations: REGULATIONS.filter((x) => categories.includes(x.owasp)).map((x) => ({ ...x })),
  };
}

function cleanError(e, clean) {
  const out = { code: e.code, message: clean(e.message || '') };
  if (e.status !== undefined) out.status = e.status;
  return out;
}

export function summarize(caseResults, repeats) {
  const counts = { vulnerable: 0, blocked: 0, inconclusive: 0, errors: 0 };
  const trialCounts = { vulnerable: 0, blocked: 0, inconclusive: 0, errors: 0 };
  const byCategory = {};
  for (const cat of CATEGORY_ORDER) {
    const list = caseResults.filter((c) => c.category === cat);
    if (!list.length) continue;
    const trials = list.flatMap((c) => c.trials);
    const vulnerableCases = list.filter((c) => c.verdict === 'VULNERABLE').length;
    const errorCases = list.filter((c) => c.verdict === 'ERROR').length;
    const vulnerableTrials = trials.filter((t) => t.verdict === 'VULNERABLE').length;
    const errorTrials = trials.filter((t) => t.verdict === 'ERROR').length;
    const nonErrorCases = list.length - errorCases;
    byCategory[cat] = {
      title: CATEGORY_INFO[cat].title,
      cases: list.length,
      vulnerableCases,
      blockedCases: list.filter((c) => c.verdict === 'BLOCKED').length,
      inconclusiveCases: list.filter((c) => c.verdict === 'INCONCLUSIVE').length,
      errorCases,
      trials: trials.length,
      vulnerableTrials,
      errorTrials,
      asr: wilson(vulnerableTrials, trials.length - errorTrials),
      asrAtK: { k: repeats, p: nonErrorCases > 0 ? vulnerableCases / nonErrorCases : null, n: nonErrorCases },
    };
  }
  let trialsTotal = 0;
  for (const c of caseResults) {
    counts[VERDICT_KEYS[c.verdict]] += 1;
    for (const t of c.trials) { trialCounts[VERDICT_KEYS[t.verdict]] += 1; trialsTotal += 1; }
  }
  return {
    cases: caseResults.length,
    trials: trialsTotal,
    ...counts,
    trialCounts,
    asr: wilson(trialCounts.vulnerable, trialsTotal - trialCounts.errors),
    byCategory,
  };
}
