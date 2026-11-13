/**
 * CLI entry: main(argv, io) → exit code. Never calls process.exit.
 * Exit codes: 0 pass / success, 1 gate FAIL or preflight fail, 2 usage / config / internal error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  VERSION, ConfigError, normalizeConfig, upgradeV1Config, applyOverrides, isMockUrl, buildPlan, runSuite,
  renderMarkdown, renderCompareMarkdown, compareReports, runPreflight, listProbes, TRANSFORMS,
  createMockTransport, MOCK_CANARY,
} from '../core/index.mjs';
import { jsonErrorText, collectSecrets, redact } from '../core/redaction.mjs';
import { parseArgs, flagsToOverrides, renderHelp } from './args.mjs';
import { createNodeTransport } from './transport.mjs';
import { renderConsole, renderPreflight, renderCompareConsole, renderProbeList, renderPlan } from './console-render.mjs';

const AUTH_MESSAGE = '✗ 권한 확인 필요: --yes 또는 설정 authorized:true 로 "소유하거나 테스트 권한이 있는 대상"임을 확인하세요.';
const CUSTOM_BODY = '{"system":"{{SYSTEM}}","message":"{{PROMPT}}"}';

function readJsonFile(path) {
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    // never echo the file excerpt V8 quotes (it can contain a key) (C-2)
    throw new Error(jsonErrorText(e));
  }
}

function isV1(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === undefined && typeof raw.url === 'string';
}

/**
 * @param {string[]} argv
 * @param {{stdout: {write: Function, isTTY?: boolean}, stderr: {write: Function, isTTY?: boolean}, env?: object, cwd?: string,
 *          transportFactory?: (target: object, network: object) => Function}} io
 */
export async function main(argv, io) {
  const out = (s) => io.stdout.write(s.endsWith('\n') ? s : s + '\n');
  const err = (s) => io.stderr.write(s.endsWith('\n') ? s : s + '\n');
  const env = io.env || {};
  const cwd = io.cwd || '.';
  let errorSecrets = [];
  const configError = (e) => {
    err('✗ 설정 오류:');
    for (const x of e.errors.length ? e.errors : [{ path: '', message: e.message }]) err(`  - ${x.path || '(설정)'}: ${x.message}`);
    return 2;
  };
  try {
    let parsed;
    try {
      parsed = parseArgs(argv);
    } catch (e) {
      if (e instanceof ConfigError) { err(`✗ ${e.message}`); err('  --help 참고'); return 2; }
      throw e;
    }
    const { command, flags, positionals } = parsed;
    if (parsed.help) { out(renderHelp(VERSION)); return 0; }
    if (parsed.version) { out(VERSION); return 0; }
    const color = !flags['no-color'] && !env.NO_COLOR && Boolean(io.stdout.isTTY);

    if (command === 'list') { out(renderProbeList(listProbes(), TRANSFORMS)); return 0; }
    if (command === 'compare') return runCompare(positionals, flags, { out, err, cwd, color });

    // ── run / probe: build config ──
    const extraWarnings = [];
    let raw = { version: 2 };
    let baseDir = null;
    if (flags.config) {
      const file = resolve(cwd, flags.config);
      try {
        raw = readJsonFile(file);
      } catch (e) {
        err(`✗ 설정 파일을 읽을 수 없습니다: ${flags.config} — ${e.message}`);
        return 2;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { err('✗ 설정 파일은 JSON 객체여야 합니다'); return 2; }
      baseDir = dirname(file);
      if (isV1(raw)) {
        let up;
        try {
          up = upgradeV1Config(raw);
        } catch (e) {
          if (e instanceof ConfigError) return configError(e);
          throw e;
        }
        raw = up.raw;
        extraWarnings.push(...up.warnings);
      }
    }
    const overrides = flagsToOverrides(flags);
    if (overrides['network.tls.caFile']) overrides['network.tls.caFile'] = resolve(cwd, overrides['network.tls.caFile']);
    raw = applyOverrides(raw, overrides);
    raw.target = raw.target && typeof raw.target === 'object' ? raw.target : {};
    if (flags.preset) {
      if (flags.preset === 'custom') {
        raw.target.provider = flags.provider || 'http';
        if (raw.target.body === undefined) raw.target.body = CUSTOM_BODY;
        if (raw.target.responsePath === undefined) raw.target.responsePath = 'reply';
      } else if (!flags.provider) raw.target.provider = flags.preset;
    }
    if (flags.body !== undefined && !flags.provider && !raw.target.provider) raw.target.provider = 'http';
    if (flags.mock) {
      raw.target = { provider: 'openai', url: `mock://${flags.mock}/v1/chat/completions`, model: 'mock-agent' };
      raw.oracles = raw.oracles && typeof raw.oracles === 'object' ? raw.oracles : {};
      if (!raw.oracles.canary) raw.oracles.canary = MOCK_CANARY;
    }
    if (!raw.target.apiKey && env.AGENT_REDTEAM_KEY && !isMockUrl(raw.target.url)) raw.target.apiKey = env.AGENT_REDTEAM_KEY;
    if (raw.judge && raw.judge.target && typeof raw.judge.target === 'object' && !raw.judge.target.apiKey && env.AGENT_REDTEAM_JUDGE_KEY) {
      raw.judge.target.apiKey = env.AGENT_REDTEAM_JUDGE_KEY;
    }

    let config;
    try {
      const n = normalizeConfig(raw, { env, baseDir });
      config = n.config;
      extraWarnings.push(...n.warnings);
    } catch (e) {
      if (e instanceof ConfigError) return configError(e);
      throw e;
    }

    errorSecrets = collectSecrets(config);

    if (command === 'run' && flags['dry-run']) {
      out(renderPlan(buildPlan(config), config, extraWarnings, { color }));
      return 0;
    }

    const judgeActive = config.judge.enabled && config.judge.target;
    const realTarget = !isMockUrl(config.target.url) || (judgeActive && !isMockUrl(config.judge.target.url));
    if (realTarget && !config.authorized) { err(AUTH_MESSAGE); return 2; }

    let ca;
    if (config.network.tls.caFile) {
      try {
        ca = readFileSync(config.network.tls.caFile);
      } catch (e) {
        err(`✗ CA 파일을 읽을 수 없습니다: ${config.network.tls.caFile} — ${e.message}`);
        return 2;
      }
    }
    if (config.network.tls.insecure) err('⚠ TLS 인증서 검증을 끈 상태로 요청합니다 (--insecure). 사내 CA는 --ca-file을 쓰십시오.');

    const factory = io.transportFactory || ((target) => (isMockUrl(target.url) ? createMockTransport() : createNodeTransport({ ca, insecure: config.network.tls.insecure })));
    const transport = factory(config.target, config.network);
    const judgeTransport = judgeActive ? factory(config.judge.target, config.network) : undefined;

    if (command === 'probe') {
      if (!flags.quiet) err('사전 점검: 대상 요청 최대 7회' + (judgeActive ? ' · judge 최대 2회' : ''));
      const result = await runPreflight(config.target, {
        transport,
        judgeTransport,
        network: config.network,
        judgeTarget: judgeActive ? config.judge.target : undefined,
        secrets: errorSecrets,
      });
      out(renderPreflight(result, { color, secrets: errorSecrets }));
      return result.ok ? 0 : 1;
    }

    const plan = buildPlan(config);
    const quiet = Boolean(flags.quiet);
    if (!quiet) {
      err(`계획: 케이스 ${plan.cases.length} · 반복 ${config.attack.repeats} · 대상 요청 최대 ${plan.estimatedRequests.target}회 · judge 최대 ${plan.estimatedRequests.judgeMax}회`);
    }
    const tty = Boolean(io.stderr.isTTY) && !quiet;
    const onProgress = tty
      ? (ev) => {
        if (ev.type === 'case-start') io.stderr.write(`\r  [${ev.caseIndex + 1}/${ev.caseCount}] ${ev.caseId}`.padEnd(70));
        if (ev.type === 'case-done' && ev.caseIndex + 1 === ev.caseCount) io.stderr.write('\r' + ' '.repeat(70) + '\r');
      }
      : undefined;
    let report;
    try {
      report = await runSuite(config, { transport, judgeTransport, onProgress, extraWarnings });
    } catch (e) {
      if (e instanceof ConfigError) { err(e.code === 'NOT_AUTHORIZED' ? AUTH_MESSAGE : `✗ ${e.message}`); return 2; }
      throw e;
    }
    out(renderConsole(report, { color, quiet }));
    try {
      if (flags.out) { const p = resolve(cwd, flags.out); writeFileSync(p, renderMarkdown(report), 'utf8'); out(`Markdown 리포트: ${flags.out}`); }
      if (flags.json) { const p = resolve(cwd, flags.json); writeFileSync(p, JSON.stringify(report, null, 2) + '\n', 'utf8'); out(`JSON 리포트: ${flags.json}`); }
    } catch (e) {
      err(`✗ 리포트 파일을 쓸 수 없습니다: ${e.message}`);
      return 2;
    }
    return report.gate.pass ? 0 : 1;
  } catch (e) {
    err(redact(`✗ 내부 오류: ${(e && e.stack) || e}`, errorSecrets));
    return 2;
  }
}

function runCompare(positionals, flags, { out, err, cwd, color }) {
  let before;
  let after;
  try {
    before = readJsonFile(resolve(cwd, positionals[0]));
    after = readJsonFile(resolve(cwd, positionals[1]));
  } catch (e) {
    err(`✗ 리포트 파일을 읽을 수 없습니다: ${e.message}`);
    return 2;
  }
  let cmp;
  try {
    cmp = compareReports(before, after);
  } catch (e) {
    if (e instanceof ConfigError) { err(`✗ ${e.message}`); return 2; }
    throw e;
  }
  out(renderCompareConsole(cmp, { color }));
  if (flags.out) {
    try {
      writeFileSync(resolve(cwd, flags.out), renderCompareMarkdown(cmp), 'utf8');
      out(`Markdown 비교 리포트: ${flags.out}`);
    } catch (e) {
      err(`✗ 비교 리포트를 쓸 수 없습니다: ${e.message}`);
      return 2;
    }
  }
  return 0;
}
