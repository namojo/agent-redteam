/**
 * Mock OpenAI-compatible / Anthropic / legacy HTTP server with quirks that imitate in-house deployments.
 * Shared by examples and tests. Binds to 127.0.0.1 and port 0 by default.
 */
import { createServer } from 'node:http';
import { mockOpenAIHandler, mockAnthropicHandler, mockLegacyHandler } from '../core/mock-agent.mjs';

export const QUIRK_DEFAULTS = Object.freeze({
  think: false,
  developerRole: 'accept',
  systemRole: 'accept',
  rejectEmptySystem: false,
  rejectArrayContent: false,
  requireHeader: null,
  noToolParser: false,
  rateLimit: 0,
  failStatus: 0,
  delayMs: 0,
  malformed: false,
  emptyChoices: false,
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export function startMockServer({ mode = 'vulnerable', host = '127.0.0.1', port = 0, quirks = {} } = {}) {
  let q = { ...QUIRK_DEFAULTS, ...quirks };
  let served = 0;
  const requests = [];
  const sockets = new Set();

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, { ...CORS, 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  };
  const error = (res, status, message, headers) => send(res, status, { error: { message } }, headers);

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      try { body = raw ? JSON.parse(raw) : raw; } catch { body = raw; }
      const path = (req.url || '/').split('?')[0];
      requests.push({ method: req.method, path, headers: { ...req.headers }, body });
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
      if (req.method === 'GET' && path === '/') { send(res, 200, `mock-agent (${mode}) — POST /v1/chat/completions | /v1/messages | /chat`); return; }
      if (req.method !== 'POST') { error(res, 405, 'POST only'); return; }

      const quirk = q;
      served += 1;
      if (quirk.delayMs > 0) await new Promise((r) => setTimeout(r, quirk.delayMs));
      if (res.destroyed) return;
      if (quirk.failStatus) { error(res, quirk.failStatus, 'mock failure'); return; }
      if (quirk.requireHeader) {
        const got = req.headers[String(quirk.requireHeader.name).toLowerCase()];
        if (got !== quirk.requireHeader.value) { error(res, 401, 'missing or invalid gateway header'); return; }
      }
      if (quirk.rateLimit && served <= quirk.rateLimit) { error(res, 429, 'rate limited', { 'retry-after': '0' }); return; }
      if (quirk.malformed) { res.writeHead(200, { ...CORS, 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); return; }
      if (typeof body !== 'object' || body === null) { error(res, 400, 'invalid JSON body'); return; }

      if (path.endsWith('/chat/completions')) {
        if (quirk.emptyChoices) { send(res, 200, { choices: [] }); return; }
        let messages = Array.isArray(body.messages) ? body.messages : [];
        if (quirk.rejectArrayContent && messages.some((m) => Array.isArray(m && m.content))) { error(res, 400, 'content must be a string'); return; }
        if (quirk.rejectEmptySystem && messages.some((m) => m && m.role === 'system' && !m.content)) { error(res, 400, 'empty system message'); return; }
        for (const role of ['developer', 'system']) {
          const behaviour = role === 'developer' ? quirk.developerRole : quirk.systemRole;
          if (!messages.some((m) => m && m.role === role)) continue;
          if (behaviour === 'reject') { error(res, 400, `unknown role: ${role}`); return; }
          if (behaviour === 'ignore') messages = messages.filter((m) => m.role !== role);
        }
        send(res, 200, mockOpenAIHandler({ ...body, messages }, { mode, think: quirk.think, noToolParser: quirk.noToolParser }));
        return;
      }
      if (path.endsWith('/messages')) { send(res, 200, mockAnthropicHandler(body, { mode })); return; }
      send(res, 200, mockLegacyHandler(body, { mode }));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const h = addr.family === 'IPv6' || String(addr.family) === '6' ? `[${addr.address}]` : addr.address;
      const origin = `http://${h}:${addr.port}`;
      resolve({
        url: `${origin}/v1/chat/completions`,
        anthropicUrl: `${origin}/v1/messages`,
        legacyUrl: `${origin}/chat`,
        origin,
        port: addr.port,
        requests,
        setQuirks(next) { q = { ...QUIRK_DEFAULTS, ...next }; served = 0; },
        close() {
          return new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          });
        },
      });
    });
  });
}
