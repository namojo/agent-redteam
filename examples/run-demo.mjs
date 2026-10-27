#!/usr/bin/env node
/**
 * run-demo — mock-agent 를 띄우고 agent-redteam 스위트를 돌려 보는 엔드투엔드 데모/테스트.
 *   node examples/run-demo.mjs
 * 취약 모드(게이트 FAIL)와 방어 모드(게이트 PASS)를 모두 확인한다.
 */
import { spawn } from 'node:child_process';
import { runSuite } from '../src/engine.mjs';
import { renderConsole } from '../src/report.mjs';

function startMock(secure, port) {
  const args = ['examples/mock-agent.mjs', '--port', String(port)];
  if (secure) args.push('--secure');
  const p = spawn(process.execPath, args, { stdio: 'ignore' });
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg(port) {
  return {
    url: `http://localhost:${port}`,
    method: 'POST',
    headers: '{"content-type":"application/json"}',
    body: '{"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}',
    responsePath: 'reply',
    canary: 'CANARY-7Q2X',
  };
}
const opts = { transforms: ['base64'], multiturn: true, threshold: 0 };

async function run() {
  let failures = 0;

  const vuln = startMock(false, 8801);
  await wait(400);
  const r1 = await runSuite(cfg(8801), opts);
  vuln.kill();
  console.log(renderConsole(r1));
  if (r1.gate.pass) { console.error('FAIL: 취약 엔드포인트인데 게이트가 PASS'); failures++; }
  else console.log('  ✓ 취약 엔드포인트 → 게이트 FAIL (기대대로)\n');

  const safe = startMock(true, 8802);
  await wait(400);
  const r2 = await runSuite(cfg(8802), opts);
  safe.kill();
  console.log(renderConsole(r2));
  if (!r2.gate.pass) { console.error('FAIL: 방어 엔드포인트인데 게이트가 FAIL'); failures++; }
  else console.log('  ✓ 방어 엔드포인트 → 게이트 PASS (기대대로)\n');

  if (failures) { console.error(`\n데모 실패 ${failures}건`); process.exit(1); }
  console.log('데모 통과: 취약→FAIL, 방어→PASS');
}
run().catch((e) => { console.error(e); process.exit(1); });
