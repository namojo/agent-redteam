import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/node/cli.mjs';
import { FLAGS, parseArgs } from '../src/node/args.mjs';
import { VERSION, PROBES } from '../src/core/index.mjs';
import { createMemoryIo } from './helpers/io.mjs';
import { assertReportShape } from './helpers/report-shape.mjs';
import { startFakeOpenAI } from './helpers/fake-openai.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'agent-redteam-'));

async function cli(argv, opts = {}) {
  const mem = createMemoryIo(opts);
  const code = await main(argv, mem.io);
  return { code, stdout: mem.stdout, stderr: mem.stderr };
}

test('--help 종료 0, FLAGS의 모든 플래그가 도움말에 있음', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0);
  for (const f of FLAGS) assert.ok(r.stdout.includes(`--${f.name}`), f.name);
  assert.match(r.stdout, /종료코드/);
  assert.match(r.stdout, /node src\/cli\.mjs run --mock vulnerable/);
  assert.equal((await cli(['run', '-h'])).code, 0);
  assert.equal((await cli(['compare', '--help'])).code, 0, '--help anywhere');
});

test('--version', async () => {
  const r = await cli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), VERSION);
});

test('모르는 플래그 → 2', async () => {
  const r = await cli(['run', '--mock', 'secure', '--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /알 수 없는 플래그: --bogus/);
  assert.equal((await cli(['compare', 'a.json', 'b.json', '--repeats', '3'])).code, 2, 'flag not valid for the command');
  assert.equal((await cli(['run', 'extra-positional'])).code, 2);
  assert.equal((await cli(['--defend=true'])).code, 2);
});

test('값 누락 → 2', async () => {
  assert.equal((await cli(['--url'])).code, 2);
  assert.equal((await cli(['--repeats', 'abc', '--mock', 'secure'])).code, 2);
  assert.equal((await cli(['--mock', 'other'])).code, 2);
  assert.equal((await cli(['--headers', '[1]', '--mock', 'secure'])).code, 2);
});

test('parseArgs: --flag=value·별칭·명령 위치', () => {
  const p = parseArgs(['--threshold=3', 'run', '--transforms', 'base64, jamo', '--no-multiturn']);
  assert.equal(p.command, 'run');
  assert.equal(p.flags['max-vulnerable'], 3);
  assert.deepEqual(p.flags.transforms, ['base64', 'jamo']);
  assert.equal(p.flags['no-multiturn'], false);
  assert.equal(parseArgs(['--mock', 'secure']).command, 'run');
});

test('실제 URL에 --yes 없음 → 2', async () => {
  const r = await cli(['run', '--provider', 'openai', '--url', 'https://llm.example.test/v1/chat/completions', '--model', 'm']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /권한 확인 필요/);
});

test('run --mock vulnerable → 1', async () => {
  const r = await cli(['run', '--mock', 'vulnerable', '--no-color']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ FAIL/);
  assert.match(r.stdout, /LLM01-override-ko/);
  assert.ok(!/\x1b\[/.test(r.stdout));
});

test('run --mock secure → 0', async () => {
  const r = await cli(['--mock', 'secure', '--quiet']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ PASS/);
  assert.ok(!r.stdout.includes('LLM01-override-ko'), 'quiet omits case lines');
});

test('--dry-run → 0, 요청 없음', async () => {
  let calls = 0;
  const r = await cli(['run', '--provider', 'openai', '--url', 'https://llm.example.test/v1/chat/completions', '--model', 'm', '--dry-run', '--repeats', '2'], {
    transportFactory: () => async () => { calls += 1; throw new Error('no requests in dry-run'); },
  });
  assert.equal(r.code, 0);
  assert.equal(calls, 0);
  assert.match(r.stdout, /대상 요청 최대 46회/);
  assert.match(r.stdout, /NO_CANARY/);
});

test('--config 잘못된 JSON → 2', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    const r = await cli(['--config', 'bad.json'], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /설정 파일을 읽을 수 없습니다/);
    assert.equal((await cli(['--config', 'missing.json'], { cwd: dir })).code, 2);
    writeFileSync(join(dir, 'bad2.json'), JSON.stringify({ version: 2, target: { provider: 'nope' } }));
    const r2 = await cli(['--config', 'bad2.json'], { cwd: dir });
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /설정 오류:\n {2}- target\.provider/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('${ENV} 누락 → 2', async () => {
  const r = await cli(['--config', join(ROOT, 'config.example.json'), '--dry-run'], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /LLM_API_KEY/);
  const ok = await cli(['--config', join(ROOT, 'config.example.json'), '--dry-run'], { env: { LLM_API_KEY: 'a-1234', GATEWAY_KEY: 'b-1234', JUDGE_API_KEY: 'c-1234' } });
  assert.equal(ok.code, 0);
});

test('BOM이 있는 설정 파일도 읽는다', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'bom.json'), '﻿' + JSON.stringify({ version: 2, target: { provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'm' }, attack: { probes: ['LLM01-override-ko'] } }));
    assert.equal((await cli(['--config', 'bom.json', '--quiet'], { cwd: dir })).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1 설정 + legacy mock 서버 → 1', async () => {
  const server = await startFakeOpenAI({ mode: 'vulnerable' });
  const dir = tmp();
  try {
    const v1 = JSON.parse(readFileSync(join(ROOT, 'examples/legacy-v1.config.json'), 'utf8'));
    v1.url = server.legacyUrl;
    writeFileSync(join(dir, 'v1.json'), JSON.stringify(v1));
    const r = await cli(['--config', 'v1.json', '--quiet', '--json', 'r.json'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /CONFIG_V1/);
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
    assert.equal(report.target.provider, 'http');
    assert.ok(server.requests.length > 0);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--out·--json 파일 생성(JSON은 assertReportShape 통과, md에 "## 배포 게이트")', async () => {
  const dir = tmp();
  try {
    const r = await cli(['--mock', 'vulnerable', '--transforms', 'jamo', '--repeats', '2', '--out', 'report.md', '--json', 'report.json', '--quiet'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Markdown 리포트: report\.md/);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assertReportShape(report);
    assert.equal(report.settings.attack.repeats, 2);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    assert.match(md, /## 배포 게이트/);
    const bad = await cli(['--mock', 'secure', '--quiet', '--out', join(dir, 'no-such-dir', 'x.md')], { cwd: dir });
    assert.equal(bad.code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fake 서버 failStatus 500 → 1 (fail-closed)', async () => {
  const server = await startFakeOpenAI({ quirks: { failStatus: 500 } });
  try {
    const r = await cli(['--provider', 'openai', '--url', server.url, '--model', 'fake', '--yes', '--retries', '0', '--quiet', '--no-multiturn']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /오류 케이스 14건이 허용치 0건을 초과/);
    const tolerated = await cli(['--provider', 'openai', '--url', server.url, '--model', 'fake', '--yes', '--retries', '0', '--quiet', '--probes', 'LLM01-override-ko', '--max-errors', '1']);
    assert.equal(tolerated.code, 0, 'maxErrors raises the tolerance explicitly');
  } finally {
    await server.close();
  }
});

test('env AGENT_REDTEAM_KEY가 apiKey로 주입되고 출력에 남지 않음', async () => {
  const server = await startFakeOpenAI();
  const dir = tmp();
  try {
    const key = 'env-key-' + 'K'.repeat(12);
    const r = await cli(['--provider', 'openai', '--url', server.url, '--model', 'fake', '--yes', '--probes', 'LLM01-override-ko', '--json', 'r.json'], { env: { AGENT_REDTEAM_KEY: key }, cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(server.requests[0].headers.authorization, 'Bearer ' + key);
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key));
    assert.ok(!readFileSync(join(dir, 'r.json'), 'utf8').includes(key));
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe --mock vulnerable → 0', async () => {
  const r = await cli(['probe', '--mock', 'vulnerable']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /사전 점검 통과/);
});

test('probe 대상 연결 실패 → 1', async () => {
  const server = await startFakeOpenAI();
  const url = server.url;
  await server.close();
  const r = await cli(['probe', '--provider', 'openai', '--url', url, '--model', 'm', '--yes', '--retries', '0', '--timeout', '2000']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /fail/);
});

test('compare 차단률 출력 → 0', async () => {
  const dir = tmp();
  try {
    assert.equal((await cli(['--mock', 'vulnerable', '--quiet', '--json', 'before.json'], { cwd: dir })).code, 1);
    assert.equal((await cli(['--mock', 'vulnerable', '--defend', '--quiet', '--json', 'after.json'], { cwd: dir })).code, 0);
    const r = await cli(['compare', 'before.json', 'after.json', '--out', 'cmp.md'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /전체 차단률 100\.0%/);
    assert.match(readFileSync(join(dir, 'cmp.md'), 'utf8'), /# agent-redteam 폐루프 비교/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare 잘못된 파일 → 2', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ schemaVersion: 99, cases: [], summary: {} }));
    assert.equal((await cli(['compare', 'x.json', 'x.json'], { cwd: dir })).code, 2);
    assert.equal((await cli(['compare', 'missing.json', 'x.json'], { cwd: dir })).code, 2);
    assert.equal((await cli(['compare', 'x.json'], { cwd: dir })).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list → 0, 모든 프로브 id 포함', async () => {
  const r = await cli(['list']);
  assert.equal(r.code, 0);
  for (const p of PROBES) assert.ok(r.stdout.includes(p.id), p.id);
  assert.match(r.stdout, /jamo/);
});

test('spawn: node src/cli.mjs run --mock secure → 0, --mock vulnerable → 1', () => {
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'src/cli.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const secure = run(['run', '--mock', 'secure', '--quiet']);
  assert.equal(secure.status, 0, secure.stderr);
  assert.match(secure.stdout, /PASS/);
  const vuln = run(['run', '--mock', 'vulnerable', '--quiet']);
  assert.equal(vuln.status, 1, vuln.stderr);
  const usage = run(['--nope']);
  assert.equal(usage.status, 2);
});
