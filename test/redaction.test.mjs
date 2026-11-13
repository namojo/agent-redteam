import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeConfig, runSuite, runPreflight, renderMarkdown, collectSecrets, redact, sanitizeUrl, createMockTransport, MOCK_CANARY,
} from '../src/core/index.mjs';
import { jsonErrorText, headerValueSecrets, urlSecrets } from '../src/core/redaction.mjs';
import { renderConsole } from '../src/node/console-render.mjs';
import { main } from '../src/node/cli.mjs';
import { createMemoryIo } from './helpers/io.mjs';

// assembled at runtime (hygiene)
const TOK = 'qaTOK' + 'P0o9i8u7y6t5r4';
const PASS = 'qaPASS' + 'w0rd9876';
const SIG = 'qaSIG' + 'abcdef123456';
const JKEY = 'qaJUDGE' + 'K1l2k3j4h5g6';
const ALL = [TOK, PASS, SIG, JKEY];

const noLeak = (text, where) => { for (const s of ALL) assert.ok(!String(text).includes(s), `${where} leaked ${s.slice(0, 6)}…`); };

function echoServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    let mode = 401;
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const bare = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (mode === 401) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `invalid credential '${bare}' for ${req.url}` } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: `디버그: 토큰 ${bare} url ${req.url}` } }] }));
        }
      });
    });
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/v1/chat/completions`,
      setMode: (m) => { mode = m; },
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
    }));
  });
}

async function cli(argv, opts = {}) {
  const mem = createMemoryIo(opts);
  const code = await main(argv, mem.io);
  return { code, stdout: mem.stdout, stderr: mem.stderr, all: mem.stdout + mem.stderr };
}

test('collectSecrets: Bearer ${ENV} 토큰·URL 비밀번호·쿼리 값·judge 키 (S-1)', () => {
  const { config } = normalizeConfig({
    version: 2,
    target: { provider: 'openai', url: 'https://user:${PW}@${HOST}/v1?sig=${SIG}&api-version=2024', model: 'm', headers: { Authorization: 'Bearer ${TOK}', 'Content-Type': 'application/json' } },
    judge: { enabled: true, target: { url: 'https://judge.example.test/v1', model: 'j', apiKey: '${JKEY}' } },
  }, { env: { TOK, PW: PASS, SIG, JKEY, HOST: 'llm.example.test' } });
  const set = collectSecrets(config);
  for (const s of ALL) assert.ok(set.includes(s), s.slice(0, 6));
  assert.ok(config.secrets.includes(TOK) && config.secrets.includes(PASS) && config.secrets.includes(SIG));
  assert.ok(!set.includes('llm.example.test'), 'an env value that is only the host is not redacted');
  assert.ok(!set.includes('application/json'));
  assert.ok(!set.includes('Bearer'));
  assert.equal(redact(`x ${TOK} y ${SIG}`, set), 'x *** y ***');
});

test('headerValueSecrets·urlSecrets: Basic 디코드·k=v·퍼센트 인코딩', () => {
  const basic = 'Basic ' + btoa('svc:' + PASS);
  assert.ok(headerValueSecrets(basic).includes(PASS));
  assert.ok(headerValueSecrets('key=' + TOK).includes(TOK));
  assert.ok(urlSecrets(`https://u:${encodeURIComponent(PASS + '@!')}@h/x?a=${encodeURIComponent(SIG + ' ')}`).includes(SIG + ' '));
  assert.equal(sanitizeUrl(`https://u:${PASS}@h.example.test/p?sig=${SIG}&b=1`), 'https://h.example.test/p?sig=***&b=***');
});

test('리포트 JSON·Markdown·콘솔에 echo된 Bearer 토큰·쿼리 값 없음 (S-1)', async () => {
  const { config, warnings } = normalizeConfig({
    version: 2, authorized: true,
    target: { provider: 'openai', url: `https://llm.example.test/v1/chat/completions?sig=\${SIG}`, model: 'm', headers: { Authorization: 'Bearer ${TOK}' } },
    attack: { probes: ['LLM01-override-ko', 'LLM07-verbatim'] }, network: { retries: 0 },
  }, { env: { TOK, SIG } });
  for (const status of [401, 200]) {
    const echo = async (req) => {
      const bare = req.headers.authorization.replace(/^Bearer\s+/, '');
      return status === 401
        ? { status, headers: {}, body: `invalid credential '${bare}' for ${req.url}` }
        : { status, headers: {}, body: JSON.stringify({ choices: [{ message: { content: `디버그: 토큰 ${bare} url ${req.url}` } }] }) };
    };
    const r = await runSuite(config, { transport: echo, extraWarnings: warnings });
    noLeak(JSON.stringify(r), `report(${status})`);
    noLeak(renderMarkdown(r), `markdown(${status})`);
    noLeak(renderConsole(r, { quiet: false }), `console(${status})`);
  }
});

test('CLI: env Bearer 헤더 + 401/200 echo → stdout·stderr·파일에 토큰 없음 (S-1)', async () => {
  const srv = await echoServer();
  const dir = mkdtempSync(join(tmpdir(), 'agent-redteam-'));
  try {
    for (const mode of [401, 200]) {
      srv.setMode(mode);
      const r = await cli(['--provider', 'openai', '--url', srv.url + '?sig=${SIG}', '--model', 'm', '--headers', '{"Authorization":"Bearer ${QA_TOK}"}', '--yes', '--retries', '0',
        '--probes', 'LLM01-override-ko', '--no-multiturn', '--json', 'r.json', '--out', 'r.md'], { env: { QA_TOK: TOK, SIG }, cwd: dir });
      assert.equal(r.code, 1);
      noLeak(r.all, `cli console ${mode}`);
      noLeak(readFileSync(join(dir, 'r.json'), 'utf8') + readFileSync(join(dir, 'r.md'), 'utf8'), `cli files ${mode}`);
    }
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run: URL userinfo·쿼리 값·${ENV} 노출 없음 (S-2)', async () => {
  const r = await cli(['--provider', 'openai', '--url', `http://user:${PASS}@127.0.0.1:9/v1?api-key=\${T}`, '--model', 'm', '--dry-run'], { env: { T: TOK } });
  assert.equal(r.code, 0);
  noLeak(r.all, 'dry-run');
  assert.match(r.stdout, /http:\/\/127\.0\.0\.1:9\/v1\?api-key=\*\*\*/);
});

test('probe 출력: 응답이 키를 되돌려 줘도 detail에 없음 + PII 마스킹 (S-3)', async () => {
  const srv = await echoServer();
  try {
    srv.setMode(200);
    const r = await cli(['probe', '--provider', 'openai', '--url', srv.url, '--model', 'm', '--key', TOK, '--yes']);
    noLeak(r.all, 'probe --key');
    assert.match(r.stdout, /토큰 \*\*\*/);
    srv.setMode(401);
    const r2 = await cli(['probe', '--provider', 'openai', '--url', srv.url, '--model', 'm', '--headers', '{"Authorization":"Bearer ${QA_TOK}"}', '--yes'], { env: { QA_TOK: TOK } });
    assert.equal(r2.code, 1);
    noLeak(r2.all, 'probe 401');
  } finally {
    await srv.close();
  }
  const pii = async () => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '예시 900101-1234567' } }] }) });
  const target = normalizeConfig({ version: 2, target: { provider: 'openai', url: 'https://x.example.test/v1', model: 'm' } }).config.target;
  const res = await runPreflight(target, { transport: pii, network: { retries: 0, timeoutMs: 1000 } });
  assert.ok(!JSON.stringify(res).includes('1234567'));
});

test('JSON 오류 메시지는 입력 발췌를 인용하지 않는다 (C-2)·v1 headers 오류는 설정 오류로 (C-1)', async () => {
  try { JSON.parse('Bearer ' + TOK); } catch (e) { assert.ok(!jsonErrorText(e).includes('qaTOK')); assert.match(jsonErrorText(e), /^JSON 문법 오류/); }
  const h = await cli(['--mock', 'secure', '--headers', 'Bearer ' + TOK]);
  assert.equal(h.code, 2);
  assert.ok(!h.stderr.includes('qaTOK'), h.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'agent-redteam-'));
  try {
    writeFileSync(join(dir, 'bad.json'), `{ "target": { "apiKey": "${TOK}" `);
    const b = await cli(['--config', 'bad.json'], { cwd: dir });
    assert.equal(b.code, 2);
    assert.ok(!b.stderr.includes('qaTOK'), b.stderr);
    writeFileSync(join(dir, 'v1.json'), JSON.stringify({ url: 'http://127.0.0.1:9/chat', body: '{"m":"{{PROMPT}}"}', headers: '{"Authorization": "Bearer ' + TOK }));
    const v = await cli(['--config', 'v1.json', '--dry-run'], { cwd: dir });
    assert.equal(v.code, 2);
    assert.match(v.stderr, /✗ 설정 오류:\n {2}- headers: /);
    assert.ok(!v.stderr.includes('내부 오류'));
    assert.ok(!v.stderr.includes('qaTOK'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge에는 마스킹된 응답만 간다 (C-3)', async () => {
  const sent = [];
  const judgeTransport = async (req) => { sent.push(req.body); return createMockTransport()(req); };
  const { config } = normalizeConfig({
    version: 2, target: { provider: 'openai', url: 'mock://vulnerable/v1/chat/completions', model: 'm' }, oracles: { canary: MOCK_CANARY },
    attack: { probes: ['LLM02-pii-sample', 'LLM02-secrets'] }, judge: { enabled: true, mode: 'all', target: { provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'j' } },
  });
  const r = await runSuite(config, { transport: createMockTransport(), judgeTransport });
  assert.equal(sent.length, 2);
  for (const b of sent) {
    assert.ok(!b.includes('900101-1234567'));
    assert.ok(!b.includes('FAKE0000'));
  }
  assert.ok(r.cases.every((c) => c.trials[0].judge.verdict === 'VULNERABLE'), 'mock judge still recognises masked leaks');
});
