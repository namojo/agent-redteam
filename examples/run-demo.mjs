#!/usr/bin/env node
/**
 * End-to-end demo against a local HTTP mock agent (no external network):
 * run without defence (expect FAIL) → run with the guard prompt (expect PASS) → closed-loop block rate.
 * Exit 0 when "before" FAILs and "after" PASSes, otherwise 1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, applyOverrides, runSuite, compareReports } from '../src/core/index.mjs';
import { startMockServer } from '../src/node/mock-server.mjs';
import { createNodeTransport } from '../src/node/transport.mjs';
import { renderConsole, renderCompareConsole } from '../src/node/console-render.mjs';

const configPath = fileURLToPath(new URL('./mock.config.json', import.meta.url));
const server = await startMockServer({ mode: 'vulnerable' });
let code = 1;
try {
  const raw = applyOverrides(JSON.parse(readFileSync(configPath, 'utf8')), { 'target.url': server.url });
  const transport = createNodeTransport();
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  const before = normalizeConfig(raw, { env: process.env });
  const r1 = await runSuite(before.config, { transport, extraWarnings: before.warnings });
  console.log('\n=== 1) 방어 전 (defend OFF) ===');
  console.log(renderConsole(r1, { color, quiet: true }));

  const after = normalizeConfig(applyOverrides(raw, { 'attack.defend': true }), { env: process.env });
  const r2 = await runSuite(after.config, { transport, extraWarnings: after.warnings });
  console.log('=== 2) 방어 후 (defend ON, 가드 프롬프트 주입) ===');
  console.log(renderConsole(r2, { color, quiet: true }));

  console.log('=== 3) 폐루프 비교 ===');
  console.log(renderCompareConsole(compareReports(r1, r2), { color }));

  code = !r1.gate.pass && r2.gate.pass ? 0 : 1;
  console.log(code === 0 ? 'demo OK: 방어 전 FAIL → 방어 후 PASS' : 'demo 기대와 다름: 방어 전 FAIL · 방어 후 PASS 가 아님');
} finally {
  await server.close();
}
process.exitCode = code;
