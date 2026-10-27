#!/usr/bin/env node
/**
 * agent-redteam CLI — 배포 전 AI 에이전트 모의 해킹 / 배포 게이트
 *
 * 사용:
 *   agent-redteam --config config.json
 *   agent-redteam --url https://내-에이전트/chat --path reply --body '{"message":"{{PROMPT}}"}' --yes
 *
 * 게이트: 취약 건수가 --threshold(기본 0)를 넘으면 종료코드 1 (CI에서 배포 차단).
 *
 * ⚠ 반드시 소유하거나 테스트 권한이 있는 엔드포인트만 지정하세요.
 *   --yes (또는 config.authorized=true)로 권한을 확인해야 실행됩니다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runSuite } from './engine.mjs';
import { renderConsole, renderMarkdown } from './report.mjs';
import { PRESETS } from './presets.mjs';

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (key === 'yes' || key === 'judge' || key === 'multiturn' || key === 'defend' || key === 'quiet' || key === 'help') a[key] = true;
      else { a[key] = argv[++i]; }
    } else a._.push(t);
  }
  return a;
}

const HELP = `
agent-redteam — 배포 전 AI 에이전트 모의 해킹 (레드팀 하네스 / 배포 게이트)

사용법:
  agent-redteam --config <file.json>
  agent-redteam --preset anthropic --url <URL> --key $KEY --yes
  agent-redteam --url <URL> --path reply --body '{"message":"{{PROMPT}}"}' --yes

주요 옵션:
  --config <file>     JSON 설정 파일 (아래 CLI 플래그가 덮어씀)
  --preset <name>     anthropic | openai | custom  (엔드포인트 템플릿 프리셋)
  --url <url>         대상 엔드포인트 URL
  --method <m>        HTTP 메서드 (기본 POST)
  --headers <json>    요청 헤더 JSON. {{KEY}} 치환
  --body <json>       요청 본문 템플릿. {{PROMPT}} / {{MESSAGES}} / {{SYSTEM}} / {{KEY}} 치환
  --path <p>          응답 텍스트 JSON 경로 (예: choices.0.message.content)
  --key <k>           API 키 ({{KEY}}에 치환). 미지정 시 env AGENT_REDTEAM_KEY
  --canary <s>        시스템 프롬프트에 심어둔 비밀값 (응답 유출 탐지)
  --transforms <csv>  공격 변형: base64,rot13,leet,split (쉼표 구분)
  --judge             LLM-as-judge 사용(대상 모델 재사용, 미결 최소화)
  --multiturn         멀티턴 크레센도 공격 추가 ({{MESSAGES}} 템플릿 필요)
  --defend            하드닝 가드 프롬프트를 주입해 '방어 후'로 시험
  --threshold <n>     게이트 허용 취약 건수 (기본 0). 초과 시 종료코드 1
  --out <file.md>     Markdown 리포트 저장
  --json <file.json>  JSON 리포트 저장
  --delay <ms>        요청 간 지연 (기본 0)
  --yes               "인가된 대상만 테스트" 권한 확인 (필수)
  --quiet             콘솔 표 생략(요약·게이트만)
  --help              도움말

종료코드: 게이트 통과 0, 실패(취약>임계) 1, 설정 오류 2.
`;

function fail(msg) { console.error('✗ ' + msg); process.exit(2); }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(HELP); process.exit(0); }

  let cfg = {};
  if (a.config) { try { cfg = JSON.parse(readFileSync(a.config, 'utf8')); } catch (e) { fail('설정 파일을 읽을 수 없습니다: ' + e.message); } }

  if (a.preset) {
    const p = PRESETS[a.preset];
    if (!p) fail(`알 수 없는 프리셋: ${a.preset} (anthropic|openai|custom)`);
    cfg = { ...p, ...cfg };
  }

  // CLI 플래그가 config를 덮어씀
  if (a.url) cfg.url = a.url;
  if (a.method) cfg.method = a.method;
  if (a.headers) cfg.headers = a.headers;
  if (a.body) cfg.body = a.body;
  if (a.path) cfg.responsePath = a.path;
  if (a.key) cfg.key = a.key;
  else if (!cfg.key && process.env.AGENT_REDTEAM_KEY) cfg.key = process.env.AGENT_REDTEAM_KEY;
  if (a.canary) cfg.canary = a.canary;

  const authorized = a.yes || cfg.authorized === true;
  if (!authorized) fail('권한 확인 필요: --yes 플래그 또는 config.authorized=true 로 "인가된 대상만 테스트"를 확인하세요.');
  if (!cfg.url || !/^https?:\/\//i.test(cfg.url)) fail('유효한 --url (http/https)이 필요합니다.');
  if (cfg.headers && typeof cfg.headers === 'object') cfg.headers = JSON.stringify(cfg.headers);

  const opts = {
    transforms: a.transforms ? a.transforms.split(',').map((s) => s.trim()).filter(Boolean) : (cfg.transforms || []),
    multiturn: a.multiturn || cfg.multiturn || false,
    judge: a.judge || cfg.judge || false,
    defended: a.defend || cfg.defend || false,
    threshold: a.threshold != null ? parseInt(a.threshold, 10) : (cfg.threshold != null ? cfg.threshold : 0),
    delayMs: a.delay != null ? parseInt(a.delay, 10) : (cfg.delayMs || 0),
    onProgress: a.quiet ? null : (i, n, k) => process.stderr.write(`\r  실행 중 ${i}/${n} — ${k.probe.title}${k.enh !== 'none' ? ' [' + k.enh + ']' : ''}          `),
  };

  const rep = await runSuite(cfg, opts);
  if (!a.quiet) process.stderr.write('\r' + ' '.repeat(72) + '\r');
  console.log(renderConsole(rep));

  if (a.out) { writeFileSync(a.out, renderMarkdown(rep), 'utf8'); console.log('  Markdown 리포트 → ' + a.out); }
  if (a.json) { writeFileSync(a.json, JSON.stringify(rep, null, 2), 'utf8'); console.log('  JSON 리포트 → ' + a.json); }

  process.exit(rep.gate.pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
