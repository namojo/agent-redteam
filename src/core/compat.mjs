/**
 * Provider request/response mapping (openai | anthropic | http template). Isomorphic module.
 */
import { GUARD_PROMPT } from './probes.mjs';
import { stripReasoning } from './oracles.mjs';

export function composeSystem(config) {
  return [config.target.systemPrompt, config.attack && config.attack.defend ? GUARD_PROMPT : ''].filter(Boolean).join('\n\n');
}

const jsonEscape = (s) => JSON.stringify(String(s ?? '')).slice(1, -1);

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = String(v);
  return out;
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

function fillTemplate(tpl, vars) {
  return String(tpl)
    .replace(/\{\{MESSAGES\}\}/g, () => vars.MESSAGES)
    .replace(/\{\{PROMPT\}\}/g, () => vars.PROMPT)
    .replace(/\{\{SYSTEM\}\}/g, () => vars.SYSTEM)
    .replace(/\{\{KEY\}\}/g, () => vars.KEY);
}

/**
 * Build a transport request.
 * @param target normalized Target
 * @param {{system: string, messages: {role: string, content: string}[], tools: object[]|null}} input
 * @param {{timeoutMs: number}} opts
 */
export function buildRequest(target, { system = '', messages = [], tools = null } = {}, { timeoutMs = 60000 } = {}) {
  const msgs = messages.map((m) => ({ role: m.role, content: String(m.content ?? '') }));
  const userHeaders = lowerHeaders(target.headers);
  const withKey = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.replace(/\{\{KEY\}\}/g, () => target.apiKey || '')]));
  const provider = target.provider;

  if (provider === 'openai') {
    let out = msgs;
    if (system) {
      if (target.systemRole === 'user-prefix') {
        const idx = out.findIndex((m) => m.role === 'user');
        out = out.map((m, i) => (i === idx ? { ...m, content: '[시스템 지시]\n' + system + '\n[/시스템 지시]\n\n' + m.content } : m));
      } else {
        out = [{ role: target.systemRole === 'developer' ? 'developer' : 'system', content: system }, ...out];
      }
    }
    const body = { ...(target.extraBody || {}), model: target.model, messages: out };
    if (target.temperature !== null && target.temperature !== undefined) body.temperature = target.temperature;
    if (target.maxTokens !== null && target.maxTokens !== undefined) body.max_tokens = target.maxTokens;
    if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    else delete body.tools;
    const headers = { 'content-type': 'application/json' };
    if (target.apiKey && !userHeaders.authorization) headers.authorization = 'Bearer ' + target.apiKey;
    Object.assign(headers, withKey(userHeaders));
    return { url: target.url, method: 'POST', headers, body: JSON.stringify(body), timeoutMs };
  }

  if (provider === 'anthropic') {
    const body = { ...(target.extraBody || {}), model: target.model, max_tokens: target.maxTokens ?? 1024, messages: msgs };
    if (system) body.system = system;
    else delete body.system;
    if (target.temperature !== null && target.temperature !== undefined) body.temperature = target.temperature;
    if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    else delete body.tools;
    const headers = { 'content-type': 'application/json' };
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    Object.assign(headers, withKey(userHeaders));
    return { url: target.url, method: 'POST', headers, body: JSON.stringify(body), timeoutMs };
  }

  // http template
  const vars = {
    MESSAGES: msgs.map((m) => JSON.stringify({ role: m.role, content: m.content })).join(','),
    PROMPT: jsonEscape(lastUser(msgs)),
    SYSTEM: jsonEscape(system),
    KEY: jsonEscape(target.apiKey || ''),
  };
  const method = String(target.method || 'POST').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(userHeaders)) headers[k] = fillTemplate(v, vars);
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = fillTemplate(target.body || '', vars);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }
  return { url: target.url, method, headers, body, timeoutMs };
}

function parseArgs(a) {
  if (a === undefined || a === null || a === '') return {};
  if (typeof a === 'object') return a;
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a);
      return v && typeof v === 'object' ? v : { _raw: a };
    } catch {
      return { _raw: a };
    }
  }
  return { _raw: String(a) };
}

/** Read a dotted path: `a.b.0.c` or `a.b[0].c`. Empty path returns obj. */
export function getPath(obj, path) {
  if (path === undefined || path === null || path === '') return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw codeError('PARSE', '응답이 JSON이 아닙니다: ' + String(body).slice(0, 120));
  }
}

/**
 * Parse a transport response into text and tool calls.
 * Throws an Error with code 'PARSE' | 'RESPONSE_PATH'.
 */
export function parseResponse(target, response) {
  const body = response && typeof response.body === 'string' ? response.body : '';
  if (target.provider === 'openai') {
    const j = parseJsonBody(body);
    if (!j || !Array.isArray(j.choices) || j.choices.length === 0) throw codeError('PARSE', '응답에 choices 없음');
    const message = (j.choices[0] && j.choices[0].message) || {};
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) text = message.content.map((p) => (p && typeof p.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('');
    let toolCalls = [];
    if (Array.isArray(message.tool_calls)) {
      toolCalls = message.tool_calls
        .filter((c) => c && c.function && c.function.name)
        .map((c) => ({ id: c.id ?? null, name: c.function.name, arguments: parseArgs(c.function.arguments) }));
    } else if (message.function_call && message.function_call.name) {
      toolCalls = [{ id: null, name: message.function_call.name, arguments: parseArgs(message.function_call.arguments) }];
    }
    return { text, toolCalls };
  }

  if (target.provider === 'anthropic') {
    const j = parseJsonBody(body);
    if (!j || !Array.isArray(j.content)) throw codeError('PARSE', '응답에 content 배열 없음');
    const texts = [];
    const toolCalls = [];
    for (const b of j.content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'tool_use' && b.name) toolCalls.push({ id: b.id ?? null, name: b.name, arguments: parseArgs(b.input) });
    }
    return { text: texts.join('\n'), toolCalls };
  }

  // http
  if (!target.responsePath) {
    let toolCalls = [];
    if (target.toolCallsPath) {
      try { toolCalls = normalizeToolCalls(getPath(JSON.parse(body), target.toolCallsPath)); } catch { toolCalls = []; }
    }
    return { text: body, toolCalls };
  }
  const j = parseJsonBody(body);
  const v = getPath(j, target.responsePath);
  if (v === undefined || v === null) throw codeError('RESPONSE_PATH', `응답 경로 ${target.responsePath}를 찾을 수 없음`);
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  const toolCalls = target.toolCallsPath ? normalizeToolCalls(getPath(j, target.toolCallsPath)) : [];
  return { text, toolCalls };
}

function normalizeToolCalls(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      id: it.id ?? null,
      name: it.name ?? (it.function && it.function.name),
      arguments: parseArgs(it.arguments ?? it.args ?? it.input ?? (it.function && it.function.arguments)),
    }))
    .filter((c) => typeof c.name === 'string' && c.name);
}

/** Extract a JSON object from model text (fences, surrounding prose, reasoning blocks). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = stripReasoning(text).text;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  t = t.trim();
  const ok = (v) => (v !== null && typeof v === 'object' ? v : null);
  try {
    return ok(JSON.parse(t));
  } catch { /* fall through */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return ok(JSON.parse(t.slice(a, b + 1))); } catch { /* ignore */ }
  }
  return null;
}
