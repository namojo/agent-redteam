/**
 * Configuration: defaults, v1 flat-config upgrade, CLI overrides, validation/normalization.
 * Isomorphic module: env is injected, files are never read here.
 */
import { ConfigError } from './errors.mjs';
import { CATEGORY_ORDER } from './constants.mjs';
import { PROBES } from './probes.mjs';
import { TRANSFORM_IDS } from './transforms.mjs';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const DEFAULTS = deepFreeze({
  version: 2,
  authorized: false,
  target: {
    provider: '', url: '', model: '', apiKey: '', headers: {}, systemRole: 'system', systemPrompt: '',
    temperature: 0, maxTokens: null, extraBody: {}, sendTools: true, method: 'POST', body: '',
    responsePath: '', toolCallsPath: '',
  },
  attack: {
    categories: ['LLM01', 'LLM02', 'LLM06', 'LLM07'], probes: [], transforms: [], multiturn: true,
    repeats: 1, defend: false, agentToolProbes: false,
  },
  oracles: { canary: '', stripReasoning: true, pii: ['rrn', 'mobile', 'card', 'secret'], forbiddenTools: [] },
  judge: { enabled: false, mode: 'fallback', target: null, maxResponseChars: 2000 },
  gate: { maxVulnerable: 0, maxErrors: 0, failOnInconclusive: false },
  network: { timeoutMs: 60000, retries: 2, retryBaseDelayMs: 500, rpm: 0, delayMs: 0, tls: { caFile: '', insecure: false } },
});

const PROVIDERS = ['openai', 'anthropic', 'http'];
const SYSTEM_ROLES = ['system', 'developer', 'user-prefix'];
const PII_TYPES = ['rrn', 'mobile', 'card', 'secret'];
const MOCK_HOSTS = ['vulnerable', 'secure'];
const TARGET_KEYS = Object.keys(DEFAULTS.target);
const SECTION_KEYS = {
  attack: Object.keys(DEFAULTS.attack),
  oracles: Object.keys(DEFAULTS.oracles),
  judge: Object.keys(DEFAULTS.judge),
  gate: Object.keys(DEFAULTS.gate),
  network: Object.keys(DEFAULTS.network),
};
const TOP_KEYS = Object.keys(DEFAULTS);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function isMockUrl(url) {
  return typeof url === 'string' && url.startsWith('mock://');
}

function isV1(raw) {
  return isObj(raw) && raw.version === undefined && typeof raw.url === 'string';
}

const V1_MAP = {
  url: 'target.url', method: 'target.method', body: 'target.body', responsePath: 'target.responsePath',
  headers: 'target.headers', key: 'target.apiKey', canary: 'oracles.canary', transforms: 'attack.transforms',
  multiturn: 'attack.multiturn', defend: 'attack.defend', judge: 'judge.enabled', threshold: 'gate.maxVulnerable',
  delayMs: 'network.delayMs', timeout: 'network.timeoutMs', authorized: 'authorized',
};

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Convert a v1 flat config to v2 (provider http). */
export function upgradeV1Config(raw) {
  const warnings = [{ code: 'CONFIG_V1', level: 'info', message: 'v1 평면 설정을 v2(http provider)로 변환했습니다. 새 설정 형식으로 옮기는 것을 권장합니다.' }];
  const out = { version: 2, target: { provider: 'http' }, attack: { multiturn: false } };
  for (const [k, v] of Object.entries(raw || {})) {
    if (!(k in V1_MAP)) {
      warnings.push({ code: 'UNKNOWN_KEY', level: 'warn', message: `알 수 없는 설정 키를 무시했습니다: ${k}` });
      continue;
    }
    if (v === undefined) continue;
    let value = v;
    if (k === 'headers' && typeof v === 'string') {
      try {
        value = v.trim() ? JSON.parse(v) : {};
      } catch (e) {
        throw new ConfigError('설정 오류', [{ path: 'headers', message: 'headers JSON 문자열을 해석할 수 없습니다: ' + e.message }]);
      }
    }
    if (k === 'judge') value = Boolean(v);
    setPath(out, V1_MAP[k], value);
  }
  return { raw: out, warnings };
}

/** Deep-copy raw config and set dotted paths. Undefined values are ignored. */
export function applyOverrides(raw2, overrides = {}) {
  const out = clone(raw2 || {}) || {};
  for (const [path, value] of Object.entries(overrides || {})) {
    if (value === undefined) continue;
    setPath(out, path, clone(value));
  }
  return out;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isAbsolutePath(p) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
}

/**
 * Validate and normalize a raw (v1 or v2) config.
 * @returns {{config: object, warnings: object[]}}
 * @throws ConfigError with every problem collected in `errors`
 */
export function normalizeConfig(raw, { env = {}, baseDir = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (code, message, level = 'warn') => {
    if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, level, message });
  };

  if (!isObj(raw)) throw new ConfigError('설정 오류', [{ path: '', message: '설정은 JSON 객체여야 합니다' }]);
  let r = raw;
  if (isV1(raw)) {
    const up = upgradeV1Config(raw);
    r = up.raw;
    for (const w of up.warnings) warn(w.code, w.message, w.level);
  }

  const unknown = (obj, allowed, prefix) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) warn('UNKNOWN_KEY', `알 수 없는 설정 키를 무시했습니다: ${prefix}${k}`);
  };
  unknown(r, TOP_KEYS, '');
  if (r.version !== undefined && r.version !== 2) err('version', 'version은 2여야 합니다 (v1 설정은 version 없이 최상위 url을 씁니다)');

  const section = (name) => {
    const v = r[name];
    if (v === undefined || v === null) return {};
    if (!isObj(v)) { err(name, '객체여야 합니다'); return {}; }
    if (SECTION_KEYS[name]) unknown(v, SECTION_KEYS[name], name + '.');
    return v;
  };

  // typed readers
  const bool = (obj, key, path, def) => {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') { err(path, 'true 또는 false여야 합니다'); return def; }
    return v;
  };
  const str = (obj, key, path, def) => {
    const v = obj[key];
    if (v === undefined || v === null) return def;
    if (typeof v !== 'string') { err(path, '문자열이어야 합니다'); return def; }
    return v;
  };
  const int = (obj, key, path, def, min, max) => {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v)) { err(path, '정수여야 합니다'); return def; }
    if (min !== undefined && v < min) { err(path, `${min} 이상이어야 합니다`); return def; }
    if (max !== undefined && v > max) { err(path, `${max} 이하여야 합니다`); return def; }
    return v;
  };
  const oneOf = (obj, key, path, def, values) => {
    const v = obj[key];
    if (v === undefined) return def;
    if (!values.includes(v)) { err(path, `다음 중 하나여야 합니다: ${values.join(', ')}`); return def; }
    return v;
  };
  const subset = (obj, key, path, def, values) => {
    const v = obj[key];
    if (v === undefined) return [...def];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { err(path, '문자열 배열이어야 합니다'); return [...def]; }
    const bad = v.filter((x) => !values.includes(x));
    if (bad.length) { err(path, `알 수 없는 값: ${bad.join(', ')}`); return [...def]; }
    return [...new Set(v)];
  };
  const subst = (value, path) => String(value).replace(ENV_RE, (m, name) => {
    const v = env ? env[name] : undefined;
    if (v === undefined || v === null) { err(path, `환경변수 ${name}이(가) 정의되지 않았습니다`); return ''; }
    return String(v);
  });

  const normTarget = (t, path, { judge = false } = {}) => {
    unknown(t, TARGET_KEYS, path + '.');
    const provider = t.provider;
    if (provider === undefined || provider === null || provider === '') err(path + '.provider', 'provider가 필요합니다 (openai | anthropic | http)');
    else if (!PROVIDERS.includes(provider)) err(path + '.provider', `다음 중 하나여야 합니다: ${PROVIDERS.join(', ')}`);
    const p = PROVIDERS.includes(provider) ? provider : 'openai';

    let url = str(t, 'url', path + '.url', '');
    if (!url) err(path + '.url', 'url이 필요합니다');
    else {
      url = subst(url, path + '.url');
      const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
      const scheme = m ? m[1].toLowerCase() : '';
      if (!['http', 'https', 'mock'].includes(scheme)) err(path + '.url', 'http://, https:// 또는 mock:// URL이어야 합니다');
      else if (scheme === 'mock') {
        const host = url.slice('mock://'.length).split(/[/?#]/)[0];
        if (!MOCK_HOSTS.includes(host)) err(path + '.url', 'mock URL의 호스트는 vulnerable 또는 secure여야 합니다');
      } else {
        try { new URL(url); } catch { err(path + '.url', 'URL 형식이 올바르지 않습니다'); }
      }
    }
    const model = str(t, 'model', path + '.model', '');
    if ((p === 'openai' || p === 'anthropic') && PROVIDERS.includes(provider) && !model) err(path + '.model', `${p} provider는 model이 필요합니다`);
    const apiKeyRaw = str(t, 'apiKey', path + '.apiKey', '');
    const apiKey = apiKeyRaw ? subst(apiKeyRaw, path + '.apiKey') : '';

    let headersRaw = t.headers === undefined || t.headers === null ? {} : t.headers;
    if (typeof headersRaw === 'string') {
      try { headersRaw = headersRaw.trim() ? JSON.parse(headersRaw) : {}; } catch { err(path + '.headers', 'headers JSON 문자열을 해석할 수 없습니다'); headersRaw = {}; }
    }
    const headers = {};
    if (!isObj(headersRaw)) err(path + '.headers', '문자열→문자열 객체여야 합니다');
    else {
      for (const [k, v] of Object.entries(headersRaw)) {
        if (typeof v !== 'string' && typeof v !== 'number') { err(`${path}.headers.${k}`, '문자열이어야 합니다'); continue; }
        headers[k.toLowerCase()] = subst(String(v), `${path}.headers.${k}`);
      }
    }
    const systemRole = oneOf(t, 'systemRole', path + '.systemRole', 'system', SYSTEM_ROLES);
    const systemPrompt = judge ? '' : str(t, 'systemPrompt', path + '.systemPrompt', '');

    let temperature = 0;
    if (t.temperature !== undefined) {
      if (t.temperature === null) temperature = null;
      else if (typeof t.temperature !== 'number' || !Number.isFinite(t.temperature)) err(path + '.temperature', '숫자 또는 null이어야 합니다');
      else temperature = t.temperature;
    }
    let maxTokens = judge ? 512 : p === 'anthropic' ? 1024 : null;
    if (t.maxTokens !== undefined) {
      if (t.maxTokens === null) {
        if (p === 'anthropic') err(path + '.maxTokens', 'anthropic provider는 maxTokens가 필요합니다 (null 불가)');
        else maxTokens = null;
      } else if (!Number.isInteger(t.maxTokens) || t.maxTokens < 1) err(path + '.maxTokens', '1 이상의 정수 또는 null이어야 합니다');
      else maxTokens = t.maxTokens;
    }
    let extraBody = {};
    if (t.extraBody !== undefined && t.extraBody !== null) {
      if (!isObj(t.extraBody)) err(path + '.extraBody', '객체여야 합니다');
      else extraBody = clone(t.extraBody);
    }
    const sendTools = bool(t, 'sendTools', path + '.sendTools', true);
    const method = str(t, 'method', path + '.method', 'POST').toUpperCase() || 'POST';
    const body = str(t, 'body', path + '.body', '');
    const responsePath = str(t, 'responsePath', path + '.responsePath', '');
    const toolCallsPath = str(t, 'toolCallsPath', path + '.toolCallsPath', '');

    if (p === 'http' && provider === 'http') {
      const hasBody = method !== 'GET' && method !== 'HEAD';
      if (hasBody && !body) err(path + '.body', 'http provider(POST)는 body 템플릿이 필요합니다 ({{PROMPT}} 또는 {{MESSAGES}})');
      const ct = headers['content-type'];
      if (hasBody && body && (!ct || /json/i.test(ct))) {
        const sample = body
          .replace(/\{\{PROMPT\}\}/g, 'test')
          .replace(/\{\{MESSAGES\}\}/g, '{"role":"user","content":"test"}')
          .replace(/\{\{SYSTEM\}\}/g, '')
          .replace(/\{\{KEY\}\}/g, 'k');
        try { JSON.parse(sample); } catch (e) { err(path + '.body', '템플릿 치환 결과가 JSON이 아닙니다: ' + e.message); }
      }
    }
    return { provider: p, url, model, apiKey, headers, systemRole, systemPrompt, temperature, maxTokens, extraBody, sendTools, method, body, responsePath, toolCallsPath };
  };

  // ── sections ──
  const authorized = bool(r, 'authorized', 'authorized', false);

  let targetRaw = r.target;
  if (targetRaw === undefined || targetRaw === null) { err('target', 'target 설정이 필요합니다 (provider, url)'); targetRaw = {}; }
  else if (!isObj(targetRaw)) { err('target', '객체여야 합니다'); targetRaw = {}; }
  const target = normTarget(targetRaw, 'target');

  const a = section('attack');
  const attack = {
    categories: subset(a, 'categories', 'attack.categories', DEFAULTS.attack.categories, CATEGORY_ORDER),
    probes: subset(a, 'probes', 'attack.probes', [], PROBES.map((p) => p.id)),
    transforms: subset(a, 'transforms', 'attack.transforms', [], TRANSFORM_IDS).filter((x) => x !== 'none'),
    multiturn: bool(a, 'multiturn', 'attack.multiturn', true),
    repeats: int(a, 'repeats', 'attack.repeats', 1, 1, 100),
    defend: bool(a, 'defend', 'attack.defend', false),
    agentToolProbes: bool(a, 'agentToolProbes', 'attack.agentToolProbes', false),
  };
  if (Array.isArray(a.categories) && a.categories.length === 0) err('attack.categories', '카테고리를 하나 이상 지정해야 합니다');

  const o = section('oracles');
  const canary = str(o, 'canary', 'oracles.canary', '');
  if (canary && canary.length < 6) err('oracles.canary', 'canary는 6자 이상이어야 합니다');
  let forbiddenTools = [];
  if (o.forbiddenTools !== undefined) {
    if (!Array.isArray(o.forbiddenTools)) err('oracles.forbiddenTools', '배열이어야 합니다');
    else {
      o.forbiddenTools.forEach((ft, i) => {
        if (typeof ft === 'string' && ft) forbiddenTools.push({ name: ft, argIncludes: null });
        else if (isObj(ft) && typeof ft.name === 'string' && ft.name) {
          if (ft.argIncludes !== undefined && ft.argIncludes !== null && typeof ft.argIncludes !== 'string') err(`oracles.forbiddenTools.${i}.argIncludes`, '문자열이어야 합니다');
          forbiddenTools.push({ name: ft.name, argIncludes: typeof ft.argIncludes === 'string' && ft.argIncludes ? ft.argIncludes : null });
        } else err(`oracles.forbiddenTools.${i}`, '도구 이름 문자열 또는 { name, argIncludes } 객체여야 합니다');
      });
    }
  }
  const oracles = {
    canary,
    stripReasoning: bool(o, 'stripReasoning', 'oracles.stripReasoning', true),
    pii: subset(o, 'pii', 'oracles.pii', DEFAULTS.oracles.pii, PII_TYPES),
    forbiddenTools,
  };

  const j = section('judge');
  const judgeEnabled = bool(j, 'enabled', 'judge.enabled', false);
  const judgeMode = oneOf(j, 'mode', 'judge.mode', 'fallback', ['fallback', 'all']);
  let judgeTarget = null;
  let sameAsTarget = false;
  if (j.target === undefined || j.target === null) {
    sameAsTarget = true;
    if (judgeEnabled) judgeTarget = { ...clone(target), systemPrompt: '', temperature: 0 };
  } else if (!isObj(j.target)) {
    err('judge.target', '객체 또는 null이어야 합니다');
  } else {
    const jt = j.target;
    const inherit = jt.url === undefined || jt.url === null || jt.url === '' || jt.url === targetRaw.url;
    // Same endpoint: inherit credentials and shape. Different endpoint: inherit only the provider, never keys/headers.
    const base = inherit ? { ...clone(targetRaw) } : { provider: targetRaw.provider };
    delete base.systemPrompt;
    delete base.temperature;
    delete base.maxTokens;
    judgeTarget = normTarget({ ...base, ...jt }, 'judge.target', { judge: true });
    sameAsTarget = judgeTarget.url === target.url && judgeTarget.model === target.model;
  }
  const judge = {
    enabled: judgeEnabled,
    mode: judgeMode,
    target: judgeTarget,
    sameAsTarget,
    maxResponseChars: int(j, 'maxResponseChars', 'judge.maxResponseChars', 2000, 200),
  };

  const g = section('gate');
  const gate = {
    maxVulnerable: int(g, 'maxVulnerable', 'gate.maxVulnerable', 0, 0),
    maxErrors: int(g, 'maxErrors', 'gate.maxErrors', 0, 0),
    failOnInconclusive: bool(g, 'failOnInconclusive', 'gate.failOnInconclusive', false),
  };

  const n = section('network');
  let tlsRaw = n.tls === undefined || n.tls === null ? {} : n.tls;
  if (!isObj(tlsRaw)) { err('network.tls', '객체여야 합니다'); tlsRaw = {}; }
  unknown(tlsRaw, ['caFile', 'insecure'], 'network.tls.');
  let caFile = str(tlsRaw, 'caFile', 'network.tls.caFile', '');
  if (caFile && baseDir && !isAbsolutePath(caFile)) caFile = String(baseDir).replace(/[\\/]+$/, '') + '/' + caFile;
  const network = {
    timeoutMs: int(n, 'timeoutMs', 'network.timeoutMs', 60000, 1000),
    retries: int(n, 'retries', 'network.retries', 2, 0, 10),
    retryBaseDelayMs: int(n, 'retryBaseDelayMs', 'network.retryBaseDelayMs', 500, 0),
    rpm: int(n, 'rpm', 'network.rpm', 0, 0),
    delayMs: int(n, 'delayMs', 'network.delayMs', 0, 0),
    tls: { caFile, insecure: bool(tlsRaw, 'insecure', 'network.tls.insecure', false) },
  };

  if (errors.length) {
    throw new ConfigError(`설정 오류 ${errors.length}건`, errors);
  }

  // ── config-stage warnings ──
  if (judge.enabled && judge.sameAsTarget) {
    warn('JUDGE_SAME_AS_TARGET', 'judge가 점검 대상과 같은 엔드포인트입니다. 대상이 스스로를 채점하므로 별도 judge 엔드포인트를 권장합니다.');
  }
  if (oracles.canary && target.systemPrompt && !target.systemPrompt.toLowerCase().includes(oracles.canary.toLowerCase())) {
    warn('CANARY_NOT_IN_SYSTEM_PROMPT', 'canary가 target.systemPrompt에 들어 있지 않습니다. 카나리 오라클이 유출을 감지하지 못할 수 있습니다.');
  }
  if (target.provider === 'http' && attack.multiturn && !target.body.includes('{{MESSAGES}}')) {
    warn('MULTITURN_UNSUPPORTED', 'http 본문 템플릿에 {{MESSAGES}}가 없어 멀티턴 크레센도를 건너뜁니다.');
  }
  if (target.provider === 'http' && attack.defend && !target.body.includes('{{SYSTEM}}')) {
    warn('DEFEND_NO_SYSTEM_SLOT', 'http 본문 템플릿에 {{SYSTEM}}이 없어 방어 가드 프롬프트를 보낼 수 없습니다.');
  }
  if (network.tls.insecure) {
    warn('INSECURE_TLS', 'TLS 인증서 검증을 끈 상태입니다(insecure). 사내 CA는 tls.caFile 또는 NODE_EXTRA_CA_CERTS로 지정하십시오.');
  }

  return { config: { version: 2, authorized, target, attack, oracles, judge, gate, network }, warnings };
}
