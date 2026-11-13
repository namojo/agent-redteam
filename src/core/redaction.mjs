/**
 * Central secret handling: one redaction set derived from the normalized config, applied by every
 * printer (report, Markdown, console, dry-run, probe, error messages). Isomorphic module.
 */

// Header values that are protocol constants, not secrets — redacting them would only garble output.
export const NON_SECRET_HEADERS = Object.freeze(['content-type', 'accept', 'anthropic-version', 'user-agent']);
const SCHEME_WORDS = new Set(['bearer', 'basic', 'token', 'apikey', 'api-key', 'digest', 'hmac', 'key']);
const MIN_WHOLE = 4;
const MIN_PART = 6;

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function tryAtob(s) {
  try {
    if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(s)) return null;
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Credential-bearing parts of a URL: userinfo password and every query value. */
export function urlSecrets(url) {
  const out = [];
  if (typeof url !== 'string') return out;
  const ui = /^[a-z][a-z0-9+.-]*:\/\/([^@/?#]*)@/i.exec(url);
  if (ui) {
    const idx = ui[1].indexOf(':');
    if (idx >= 0) {
      const pass = ui[1].slice(idx + 1);
      out.push(pass, safeDecode(pass));
    }
  }
  for (const m of url.matchAll(/[?&][^=&#]+=([^&#]*)/g)) {
    if (m[1].length >= MIN_PART) out.push(m[1], safeDecode(m[1]));
  }
  return out;
}

/** A header value plus the credential inside it (`Bearer <tok>`, `Basic <b64>` and its decoded password, `k=v` parts). */
export function headerValueSecrets(value) {
  const out = [];
  const v = String(value ?? '');
  if (!v) return out;
  out.push(v);
  const scheme = /^\s*([A-Za-z-]+)\s+(\S.*)$/.exec(v);
  if (scheme && SCHEME_WORDS.has(scheme[1].toLowerCase())) {
    const cred = scheme[2].trim();
    out.push(cred);
    const decoded = tryAtob(cred);
    if (decoded) {
      out.push(decoded);
      const i = decoded.indexOf(':');
      if (i >= 0) out.push(decoded.slice(i + 1));
    }
  }
  for (const part of v.split(/[\s,;]+/)) {
    for (const p of part.split('=')) {
      if (p.length >= MIN_PART && !SCHEME_WORDS.has(p.toLowerCase())) out.push(p);
    }
  }
  return out;
}

/** Every secret string a normalized Target can leak: apiKey, resolved header values and their credentials, URL credentials. */
export function targetSecrets(target) {
  if (!target) return [];
  const out = [];
  if (target.apiKey) out.push(target.apiKey);
  for (const [k, raw] of Object.entries(target.headers || {})) {
    if (NON_SECRET_HEADERS.includes(String(k).toLowerCase())) continue;
    const v = String(raw).replace(/\{\{KEY\}\}/g, () => target.apiKey || '');
    out.push(...headerValueSecrets(v));
    if (v !== raw) out.push(...headerValueSecrets(raw));
  }
  out.push(...urlSecrets(target.url));
  return out;
}

function finalize(list) {
  return [...new Set(list.filter((s) => typeof s === 'string' && s.length >= MIN_WHOLE && !/^\{\{KEY\}\}$/.test(s)))]
    .sort((a, b) => b.length - a.length);
}

/**
 * The redaction set for a normalized config: `config.secrets` (environment values recorded by
 * normalizeConfig) plus everything derivable from the target and judge target. Longest first.
 */
export function collectSecrets(config) {
  if (!config) return [];
  const list = [...(Array.isArray(config.secrets) ? config.secrets : [])];
  list.push(...targetSecrets(config.target));
  if (config.judge && config.judge.target) list.push(...targetSecrets(config.judge.target));
  return finalize(list);
}

export function secretsOf(...targets) {
  return finalize(targets.flatMap((t) => targetSecrets(t)));
}

/** Replace every secret string with *** */
export function redact(text, secrets) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  for (const sec of secrets || []) {
    if (typeof sec === 'string' && sec.length >= MIN_WHOLE) s = s.split(sec).join('***');
  }
  return s;
}

/** Remove userinfo and replace query values with *** */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1')
    .replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=***');
}

/**
 * A JSON.parse error message without the input excerpt V8 quotes (which can contain a token).
 */
export function jsonErrorText(e) {
  const msg = String((e && e.message) || e || '');
  const pos = /position (\d+)/.exec(msg);
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return `JSON 문법 오류 (${lc[1]}행 ${lc[2]}열)`;
  if (pos) return `JSON 문법 오류 (위치 ${pos[1]})`;
  if (/end of (JSON )?input/i.test(msg)) return 'JSON 문법 오류 (입력이 중간에 끝남)';
  return 'JSON 문법 오류';
}
