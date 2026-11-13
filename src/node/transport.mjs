/**
 * Node transport: node:http / node:https with custom CA, insecure mode and a total timeout.
 * Retries, backoff and rate limits live in core/client.mjs (D6).
 */
import http from 'node:http';
import https from 'node:https';
import { TransportError } from '../core/errors.mjs';

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TLS_HINT = '사내 CA라면 tls.caFile(--ca-file) 또는 NODE_EXTRA_CA_CERTS 설정을 확인하십시오';

export function mapNodeError(e) {
  if (e instanceof TransportError) return e;
  const code = e && e.code ? String(e.code) : '';
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
    return new TransportError('TLS', `TLS 오류 ${code}: ${e.message} — ${TLS_HINT}`);
  }
  return new TransportError('NETWORK', `네트워크 오류${code ? ' ' + code : ''}: ${(e && e.message) || e}`);
}

/**
 * @param {{ca?: string|Buffer, insecure?: boolean, _request?: Function}} opts
 * @returns transport(request) → Promise<{status, headers, body}>
 */
export function createNodeTransport({ ca, insecure = false, _request } = {}) {
  return function nodeTransport(req) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      let url;
      try {
        url = new URL(req.url);
      } catch {
        reject(new TransportError('NETWORK', `잘못된 URL: ${req.url}`));
        return;
      }
      const isHttps = url.protocol === 'https:';
      const requestFn = _request || (isHttps ? https.request : http.request);
      const headers = { ...(req.headers || {}) };
      const hasBody = req.body !== undefined && req.body !== null;
      if (hasBody) headers['content-length'] = String(Buffer.byteLength(String(req.body), 'utf8'));
      const options = { method: req.method || 'POST', headers, agent: false };
      if (isHttps) {
        if (ca) options.ca = ca;
        options.rejectUnauthorized = !insecure;
      }
      let r;
      const timeoutMs = req.timeoutMs || 60000;
      const timer = setTimeout(() => {
        const err = new TransportError('TIMEOUT', `요청 시간 초과 (${timeoutMs}ms)`);
        if (r) r.destroy(err);
        done(reject, err);
      }, timeoutMs);
      try {
        r = requestFn(url, options, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const out = {};
            for (const [k, v] of Object.entries(res.headers || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
            done(resolve, { status: res.statusCode, headers: out, body: Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))).toString('utf8') });
          });
          res.on('error', (e) => done(reject, mapNodeError(e)));
          res.on('aborted', () => done(reject, new TransportError('NETWORK', '응답이 중단되었습니다')));
        });
      } catch (e) {
        done(reject, mapNodeError(e));
        return;
      }
      r.on('error', (e) => done(reject, mapNodeError(e)));
      if (hasBody) r.end(String(req.body));
      else r.end();
    });
  };
}
