/**
 * Request client: retries with exponential backoff, retry-after, rpm limit, fixed delay, secret redaction.
 * Lives in core so the web console and CLI behave the same (D6). Isomorphic module.
 */
import { buildRequest, parseResponse } from './compat.mjs';
import { TransportError } from './errors.mjs';
import { redact, secretsOf } from './redaction.mjs';

export { redact };

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 30000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_NETWORK = { timeoutMs: 60000, retries: 2, retryBaseDelayMs: 500, rpm: 0, delayMs: 0 };

/**
 * @param target normalized Target
 * @param {{transport: Function, network?: object, sleep?: Function, now?: Function, secrets?: string[]}} deps
 * @returns {{ send(input): Promise<SendResult> }}
 */
export function createClient(target, { transport, network = {}, sleep = defaultSleep, now = Date.now, secrets = [] } = {}) {
  if (typeof transport !== 'function') throw new TypeError('createClient: transport function required');
  const net = { ...DEFAULT_NETWORK, ...network };
  const secretList = [...new Set([...(secrets || []), ...secretsOf(target)])].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  let sentCount = 0;
  let lastStart = null;

  const fail = (code, message, extra, started, attempts) => ({
    ok: false,
    error: { code, message: redact(message, secretList), ...extra },
    latencyMs: Math.max(0, now() - started),
    attempts,
  });

  async function pace() {
    if (sentCount > 0 && net.delayMs > 0) await sleep(net.delayMs);
    if (net.rpm > 0 && lastStart !== null) {
      const wait = lastStart + 60000 / net.rpm - now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now();
    sentCount += 1;
  }

  async function send(input) {
    const started = now();
    let attempts = 0;
    let request;
    try {
      request = buildRequest(target, input, { timeoutMs: net.timeoutMs });
    } catch (e) {
      return fail('PARSE', '요청을 만들 수 없습니다: ' + (e && e.message), {}, started, attempts);
    }
    const maxAttempts = Math.max(1, (net.retries | 0) + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await pace();
      attempts += 1;
      const isLast = attempt === maxAttempts - 1;
      let res;
      try {
        res = await transport(request);
      } catch (e) {
        const code = e instanceof TransportError || (e && ['TIMEOUT', 'NETWORK', 'TLS'].includes(e.code)) ? e.code : 'NETWORK';
        if (code === 'NETWORK' && !isLast) {
          await sleep(Math.min(MAX_WAIT_MS, net.retryBaseDelayMs * 2 ** attempt));
          continue;
        }
        return fail(code, (e && e.message) || String(e), {}, started, attempts);
      }
      const status = res.status;
      if (RETRY_STATUS.has(status) && !isLast) {
        const ra = res.headers && res.headers['retry-after'];
        const wait = ra !== undefined && /^\s*\d+(\.\d+)?\s*$/.test(String(ra))
          ? Number(ra) * 1000
          : net.retryBaseDelayMs * 2 ** attempt;
        await sleep(Math.min(MAX_WAIT_MS, wait));
        continue;
      }
      if (status < 200 || status >= 300) {
        return fail('HTTP', `HTTP ${status} · ${String(res.body ?? '').slice(0, 200)}`, { status }, started, attempts);
      }
      try {
        const parsed = parseResponse(target, res);
        return { ok: true, text: parsed.text, toolCalls: parsed.toolCalls, status, latencyMs: Math.max(0, now() - started), attempts };
      } catch (e) {
        const code = e && (e.code === 'RESPONSE_PATH' || e.code === 'PARSE') ? e.code : 'PARSE';
        return fail(code, (e && e.message) || '응답 파싱 실패', {}, started, attempts);
      }
    }
    /* c8 ignore next */
    return fail('NETWORK', '재시도 한도 초과', {}, started, attempts);
  }

  return { send };
}
