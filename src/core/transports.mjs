/**
 * Transports available in every runtime: in-process mock and fetch. Isomorphic module.
 * transport(request) → Promise<{ status, headers (lowercase), body }>; network failures reject with TransportError.
 */
import { TransportError } from './errors.mjs';
import { mockOpenAIHandler, mockAnthropicHandler, mockLegacyHandler } from './mock-agent.mjs';

function pathOf(url) {
  // mock://host/path?x → /path ; works without relying on URL parsing of custom schemes
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  return { host: m ? m[1] : '', path: m && m[2] ? m[2] : '/' };
}

/** Route a POST body to the mock handler that matches the path (same routing as the node mock server). */
export function routeMock(path, body, { mode, quirks = {} } = {}) {
  if (path.endsWith('/chat/completions')) return mockOpenAIHandler(body, { mode, think: quirks.think || false, noToolParser: Boolean(quirks.noToolParser) });
  if (path.endsWith('/messages')) return mockAnthropicHandler(body, { mode });
  return mockLegacyHandler(body, { mode });
}

export function createMockTransport({ mode, quirks = {} } = {}) {
  return async function mockTransport(req) {
    const { host, path } = pathOf(String(req.url || ''));
    const m = mode ?? host;
    const json = { 'content-type': 'application/json' };
    if (m !== 'vulnerable' && m !== 'secure') {
      return { status: 400, headers: json, body: JSON.stringify({ error: { message: 'mock host must be vulnerable or secure' } }) };
    }
    if (String(req.method || 'POST').toUpperCase() !== 'POST') {
      return { status: 405, headers: json, body: JSON.stringify({ error: { message: 'POST only' } }) };
    }
    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      return { status: 400, headers: json, body: JSON.stringify({ error: { message: 'invalid JSON body' } }) };
    }
    return { status: 200, headers: json, body: JSON.stringify(routeMock(path, body, { mode: m, quirks })) };
  };
}

export function createFetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async function fetchTransport(req) {
    if (typeof fetchImpl !== 'function') throw new TransportError('NETWORK', 'fetch를 사용할 수 없는 환경입니다');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, req.timeoutMs || 60000);
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal });
      const body = await res.text();
      const headers = {};
      if (res.headers && typeof res.headers.forEach === 'function') res.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
      return { status: res.status, headers, body };
    } catch (e) {
      if (timedOut) throw new TransportError('TIMEOUT', `요청 시간 초과 (${req.timeoutMs}ms)`);
      throw new TransportError('NETWORK', `네트워크 오류: ${(e && e.message) || e} — 브라우저라면 대상이 CORS를 허용하는지 확인하십시오`);
    } finally {
      clearTimeout(timer);
    }
  };
}
