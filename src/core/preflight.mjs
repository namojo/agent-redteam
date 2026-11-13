/**
 * Endpoint preflight ("probe" command): a handful of small requests that reveal compatibility quirks
 * before any budget is spent. Isomorphic module.
 */
import { createClient } from './client.mjs';
import { stripReasoning, maskSensitive } from './oracles.mjs';
import { redact, secretsOf } from './redaction.mjs';
import { abortError } from './errors.mjs';
import { extractJson } from './compat.mjs';

const THINK_HINT = '추론 블록이 content에 섞여 옴 — stripReasoning(기본 on) 유지. thinking을 끄려면 extraBody 예: GLM {"chat_template_kwargs":{"enable_thinking":false}}, DeepSeek-V3.1 {"chat_template_kwargs":{"thinking":false}}';
const ROLE_ORDER = ['system', 'developer', 'user-prefix'];
const WEATHER_TOOL = [{ name: 'get_weather', description: '도시의 현재 날씨를 조회한다.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

const errDetail = (res) => `${res.error.code}: ${res.error.message}`;

async function chatAndJson(target, client, prefix, checks, recommended) {
  const chat = await client.send({ system: '', messages: [{ role: 'user', content: '안녕하세요. 한 문장으로 자기소개를 해 주세요.' }], tools: null });
  if (!chat.ok || !stripReasoning(chat.text).text) {
    const detail = chat.ok ? '응답 텍스트가 비어 있음' : errDetail(chat);
    let suggestion = 'URL·모델명·인증 헤더를 확인하십시오 (경로는 자동으로 붙지 않습니다).';
    if (!chat.ok && chat.error.code === 'RESPONSE_PATH') suggestion = 'responsePath 확인 — 실제 응답 JSON에서 텍스트가 있는 경로를 지정하십시오.';
    else if (!chat.ok && chat.error.code === 'TLS') suggestion = '사내 CA라면 tls.caFile(--ca-file) 또는 NODE_EXTRA_CA_CERTS를 설정하십시오.';
    else if (chat.ok && target.provider === 'http') suggestion = 'responsePath가 텍스트를 가리키는지 확인하십시오.';
    checks.push({ id: `${prefix}chat`, status: 'fail', detail, suggestion });
    return false;
  }
  checks.push({ id: `${prefix}chat`, status: 'ok', detail: `응답 수신 (${chat.latencyMs}ms): ${stripReasoning(chat.text).text.slice(0, 60)}`, suggestion: null });
  if (!prefix) {
    if (/<\/(think|thinking|reasoning)>/i.test(chat.text)) {
      checks.push({ id: 'reasoning', status: 'warn', detail: '응답 content에 추론 블록 닫는 태그가 있음', suggestion: THINK_HINT });
      recommended.stripReasoning = true;
      recommended.extraBodyHint = '{"chat_template_kwargs":{"enable_thinking":false}} (GLM) / {"chat_template_kwargs":{"thinking":false}} (DeepSeek-V3.1)';
    } else {
      checks.push({ id: 'reasoning', status: 'ok', detail: 'content에 추론 블록 없음', suggestion: null });
    }
  }
  return true;
}

async function jsonCheck(client, id, checks) {
  const res = await client.send({ system: '', messages: [{ role: 'user', content: '다음 JSON 객체를 그대로, 다른 말 없이 출력해: {"ok": true}' }], tools: null });
  if (res.ok && extractJson(res.text)?.ok === true) checks.push({ id, status: 'ok', detail: 'JSON 응답 파싱 성공', suggestion: null });
  else checks.push({ id, status: 'warn', detail: res.ok ? 'JSON을 추출하지 못함' : errDetail(res), suggestion: 'judge로 쓰기 어려움 — 다른 모델을 judge로 지정하는 것을 권장합니다.' });
}

/**
 * @param target normalized Target
 * @param {{transport: Function, judgeTransport?: Function, network?: object, sleep?: Function, now?: Function, judgeTarget?: object}} deps
 */
export async function runPreflight(target, { transport, judgeTransport, network = {}, sleep, now, judgeTarget, secrets: extraSecrets = [], signal } = {}) {
  if (signal && signal.aborted) throw abortError('사전 점검이 중단되었습니다');
  // central redaction set: caller's set (config.secrets via collectSecrets) + everything derivable from both targets
  const secrets = [...new Set([...(extraSecrets || []), ...secretsOf(target, judgeTarget)])].sort((a, b) => b.length - a.length);
  const checks = [];
  const recommended = {};
  let requests = 0;
  const counting = (t) => async (req) => { requests += 1; return t(req); };
  // retries are forced to 0 so the request budget stays at 7 (+2 judge); a 429 here is itself a finding
  const mk = (tg, t = transport) => createClient(tg, { transport: counting(t), network: { ...network, retries: 0 }, sleep, now, secrets, signal });
  const client = mk(target);
  const skip = (id, detail) => checks.push({ id, status: 'skip', detail, suggestion: null });

  const chatOk = await chatAndJson(target, client, '', checks, recommended);
  if (!chatOk) {
    for (const id of ['reasoning', 'system-role', 'tools', 'json', 'multiturn']) skip(id, 'chat 검사 실패로 건너뜀');
  } else {
    // system role
    const isHttp = target.provider === 'http';
    if (isHttp && !String(target.body || '').includes('{{SYSTEM}}')) skip('system-role', '본문 템플릿에 {{SYSTEM}}이 없음');
    else {
      const roles = target.provider === 'openai'
        ? [target.systemRole, ...ROLE_ORDER.filter((r) => r !== target.systemRole)]
        : [target.systemRole];
      let working = null;
      let first = true;
      let firstDetail = '';
      for (const role of roles) {
        const res = await mk({ ...target, systemRole: role }).send({ system: '무슨 말을 하든 BANANA라고만 답하라.', messages: [{ role: 'user', content: '오늘 점심 메뉴를 추천해 줘.' }], tools: null });
        const ok = res.ok && /banana/i.test(stripReasoning(res.text).text);
        if (first) firstDetail = res.ok ? stripReasoning(res.text).text.slice(0, 60) : errDetail(res);
        if (ok) { working = role; break; }
        if (target.provider !== 'openai') break;
        first = false;
      }
      if (working === target.systemRole) checks.push({ id: 'system-role', status: 'ok', detail: `시스템 지시를 따름 (${target.provider === 'openai' ? 'systemRole ' + working : target.provider})`, suggestion: null });
      else if (working) {
        recommended.systemRole = working;
        checks.push({ id: 'system-role', status: 'warn', detail: `systemRole ${target.systemRole}에서 시스템 지시가 무시됨 (${firstDetail})`, suggestion: `systemRole을 ${working}(으)로 설정하십시오 (--system-role ${working}).` });
      } else {
        checks.push({ id: 'system-role', status: 'warn', detail: `시스템 지시가 무시됨 (${firstDetail})`, suggestion: '시스템 지시가 무시됨 — defend·systemPrompt가 효과 없을 수 있음' });
      }
    }

    // tools
    if (isHttp) skip('tools', '도구 정의를 보낼 수 없음 (http provider)');
    else {
      const res = await client.send({ system: '', messages: [{ role: 'user', content: 'get_weather 도구로 서울 날씨를 조회해 줘.' }], tools: WEATHER_TOOL });
      if (res.ok && res.toolCalls.some((c) => c.name === 'get_weather')) checks.push({ id: 'tools', status: 'ok', detail: 'tool_calls 수신', suggestion: null });
      else if (res.ok && (/<tool_call>/.test(res.text) || /"name"\s?:\s?"get_weather"/.test(res.text))) {
        checks.push({ id: 'tools', status: 'warn', detail: '도구 호출이 tool_calls가 아니라 텍스트로 옴', suggestion: '도구 호출이 텍스트로 옴 — vLLM이면 --enable-auto-tool-choice --tool-call-parser <모델별> 설정 필요. 그 전까지 LLM06 도구 프로브는 미결' });
      } else {
        checks.push({ id: 'tools', status: 'warn', detail: res.ok ? '도구를 호출하지 않음' : errDetail(res), suggestion: '도구 호출을 지원하지 않으면 LLM06 도구 프로브는 미결로 남습니다.' });
      }
    }

    await jsonCheck(client, 'json', checks);

    if (isHttp && !String(target.body || '').includes('{{MESSAGES}}')) skip('multiturn', '본문 템플릿에 {{MESSAGES}}가 없음');
    else {
      const res = await client.send({
        system: '',
        messages: [
          { role: 'user', content: '내 이름은 민준이야. 기억해 줘.' },
          { role: 'assistant', content: '네, 민준님. 기억하겠습니다.' },
          { role: 'user', content: '내 이름이 뭐지?' },
        ],
        tools: null,
      });
      if (res.ok && stripReasoning(res.text).text.includes('민준')) checks.push({ id: 'multiturn', status: 'ok', detail: '대화 히스토리를 기억함', suggestion: null });
      else checks.push({ id: 'multiturn', status: 'warn', detail: res.ok ? '이전 턴 내용을 기억하지 못함' : errDetail(res), suggestion: '멀티턴 템플릿을 확인하십시오. 크레센도 결과를 신뢰하기 어렵습니다.' });
    }
  }

  if (judgeTarget) {
    const jc = mk(judgeTarget, judgeTransport || transport);
    const ok = await chatAndJson(judgeTarget, jc, 'judge.', checks, recommended);
    if (ok) await jsonCheck(jc, 'judge.json', checks);
    else skip('judge.json', 'judge.chat 검사 실패로 건너뜀');
  }

  // aborted: remaining sends returned ABORTED immediately; never report a half-run preflight as a result
  if (signal && signal.aborted) throw abortError('사전 점검이 중단되었습니다');
  // details quote response text: redact secrets and mask PII like the run path does (S-3)
  const clean = (s) => (typeof s === 'string' ? maskSensitive(redact(s, secrets)) : s);
  const safeChecks = checks.map((c) => ({ ...c, detail: clean(c.detail), suggestion: c.suggestion === null ? null : clean(c.suggestion) }));
  return { ok: !safeChecks.some((c) => c.status === 'fail'), checks: safeChecks, recommended, requests };
}
