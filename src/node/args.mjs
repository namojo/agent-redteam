/**
 * CLI flag table (single source for the parser, help text and tests) and argument parser.
 */
import { ConfigError } from '../core/errors.mjs';
import { jsonErrorText } from '../core/redaction.mjs';

export const COMMANDS = ['run', 'probe', 'compare', 'list'];
const RP = ['run', 'probe'];
const ALL = ['run', 'probe', 'compare', 'list'];

/**
 * type: 'string' | 'int' | 'number' | 'csv' | 'json' | 'bool'
 * path: config path the value maps to (null when handled by the CLI itself)
 */
export const FLAGS = Object.freeze([
  { name: 'config', type: 'string', arg: '<file>', path: null, commands: RP, desc: 'JSON 설정 파일 (CLI 플래그가 덮어씀)' },
  { name: 'provider', type: 'string', arg: '<p>', values: ['openai', 'anthropic', 'http'], path: 'target.provider', commands: RP, desc: '대상 provider: openai | anthropic | http' },
  { name: 'preset', type: 'string', arg: '<p>', values: ['openai', 'anthropic', 'custom'], path: null, commands: RP, desc: '호환 별칭. custom = http + {"system":"{{SYSTEM}}","message":"{{PROMPT}}"} + responsePath reply' },
  { name: 'url', type: 'string', arg: '<u>', path: 'target.url', commands: RP, desc: '대상 엔드포인트 전체 URL (경로 자동 추가 없음)' },
  { name: 'model', type: 'string', arg: '<m>', path: 'target.model', commands: RP, desc: '모델 이름 (openai·anthropic 필수)' },
  { name: 'key', type: 'string', arg: '<k>', path: 'target.apiKey', commands: RP, desc: 'API 키 (없으면 env AGENT_REDTEAM_KEY). 리포트에 기록하지 않음' },
  { name: 'method', type: 'string', arg: '<m>', path: 'target.method', commands: RP, desc: 'HTTP 메서드 (http provider, 기본 POST)' },
  { name: 'headers', type: 'json', arg: '<json>', path: 'target.headers', commands: RP, desc: '요청 헤더 JSON 객체. 값에 {{KEY}}·${ENV} 치환' },
  { name: 'body', type: 'string', arg: '<tpl>', path: 'target.body', commands: RP, desc: '본문 템플릿 {{PROMPT}} {{MESSAGES}} {{SYSTEM}} {{KEY}} (provider 미지정이면 http)' },
  { name: 'path', type: 'string', arg: '<p>', path: 'target.responsePath', commands: RP, desc: '응답 텍스트 JSON 경로 (예: choices.0.message.content)' },
  { name: 'tool-calls-path', type: 'string', arg: '<p>', path: 'target.toolCallsPath', commands: RP, desc: '응답의 도구 호출 배열 경로 (http provider)' },
  { name: 'system-role', type: 'string', arg: '<r>', values: ['system', 'developer', 'user-prefix'], path: 'target.systemRole', commands: RP, desc: '시스템 지시 전달 방식: system | developer | user-prefix (openai)' },
  { name: 'system-prompt', type: 'string', arg: '<s>', path: 'target.systemPrompt', commands: RP, desc: '대상에 보낼 시스템 프롬프트 (카나리를 여기 심음)' },
  { name: 'temperature', type: 'number', arg: '<n>', path: 'target.temperature', commands: RP, desc: 'temperature (기본 0, 항상 전송)' },
  { name: 'canary', type: 'string', arg: '<s>', path: 'oracles.canary', commands: ['run'], desc: '시스템 프롬프트에 심은 비밀 토큰 (6자 이상)' },
  { name: 'categories', type: 'csv', arg: '<csv>', path: 'attack.categories', commands: ['run'], desc: 'OWASP 카테고리: LLM01,LLM02,LLM06,LLM07' },
  { name: 'probes', type: 'csv', arg: '<csv>', path: 'attack.probes', commands: ['run'], desc: '프로브 id 필터 (list 명령으로 확인)' },
  { name: 'transforms', type: 'csv', arg: '<csv>', path: 'attack.transforms', commands: ['run'], desc: '인코딩 변형: base64,rot13,leet,split,jamo' },
  { name: 'multiturn', type: 'bool', value: true, path: 'attack.multiturn', commands: ['run'], desc: '멀티턴 크레센도 포함 (기본 ON)' },
  { name: 'no-multiturn', type: 'bool', value: false, path: 'attack.multiturn', commands: ['run'], desc: '멀티턴 크레센도 제외' },
  { name: 'repeats', type: 'int', arg: '<n>', path: 'attack.repeats', commands: ['run'], desc: '케이스당 반복 시도 수 1..100 (ASR@k, Wilson CI)' },
  { name: 'defend', type: 'bool', value: true, path: 'attack.defend', commands: ['run'], desc: '방어 가드 프롬프트를 덧붙여 재시험 (폐루프)' },
  { name: 'agent-tool-probes', type: 'bool', value: true, path: 'attack.agentToolProbes', commands: ['run'], desc: '대상이 자기 도구를 실행하는 구성에서도 도구 프로브 실행 (더미 도구 인스턴스만)' },
  { name: 'no-strip-reasoning', type: 'bool', value: false, path: 'oracles.stripReasoning', commands: ['run'], desc: '<think> 추론 블록 제거 끔' },
  { name: 'judge', type: 'bool', value: true, path: 'judge.enabled', commands: RP, desc: 'LLM judge 사용 (미결 해소)' },
  { name: 'judge-mode', type: 'string', arg: '<m>', values: ['fallback', 'all'], path: 'judge.mode', enablesJudge: true, commands: ['run'], desc: 'judge 모드: fallback(미결만) | all(보정 지표 산출)' },
  { name: 'judge-provider', type: 'string', arg: '<p>', values: ['openai', 'anthropic', 'http'], path: 'judge.target.provider', enablesJudge: true, commands: RP, desc: 'judge provider' },
  { name: 'judge-url', type: 'string', arg: '<u>', path: 'judge.target.url', enablesJudge: true, commands: RP, desc: 'judge 엔드포인트 URL (대상과 다른 엔드포인트 권장)' },
  { name: 'judge-model', type: 'string', arg: '<m>', path: 'judge.target.model', enablesJudge: true, commands: RP, desc: 'judge 모델' },
  { name: 'judge-key', type: 'string', arg: '<k>', path: 'judge.target.apiKey', enablesJudge: true, commands: RP, desc: 'judge API 키 (없으면 env AGENT_REDTEAM_JUDGE_KEY)' },
  { name: 'max-vulnerable', alias: 'threshold', type: 'int', arg: '<n>', path: 'gate.maxVulnerable', commands: ['run'], desc: '게이트 취약 케이스 허용 수 (기본 0)' },
  { name: 'max-errors', type: 'int', arg: '<n>', path: 'gate.maxErrors', commands: ['run'], desc: '게이트 오류 케이스 허용 수 (기본 0)' },
  { name: 'fail-on-inconclusive', type: 'bool', value: true, path: 'gate.failOnInconclusive', commands: ['run'], desc: '미결 케이스가 있으면 게이트 FAIL' },
  { name: 'timeout', type: 'int', arg: '<ms>', path: 'network.timeoutMs', commands: RP, desc: '요청당 타임아웃 ms (기본 60000)' },
  { name: 'retries', type: 'int', arg: '<n>', path: 'network.retries', commands: RP, desc: '429·5xx·네트워크 오류 재시도 횟수 (기본 2)' },
  { name: 'rpm', type: 'int', arg: '<n>', path: 'network.rpm', commands: RP, desc: '분당 요청 상한 (0=무제한)' },
  { name: 'delay', type: 'int', arg: '<ms>', path: 'network.delayMs', commands: RP, desc: '연속 요청 사이 고정 지연 ms' },
  { name: 'ca-file', type: 'string', arg: '<path>', path: 'network.tls.caFile', commands: RP, desc: '사내 CA PEM 파일 (현재 디렉터리 기준)' },
  { name: 'insecure', type: 'bool', value: true, path: 'network.tls.insecure', commands: RP, desc: 'TLS 인증서 검증 끔 (경고와 함께만)' },
  { name: 'mock', type: 'string', arg: '<mode>', values: ['vulnerable', 'secure'], path: null, commands: RP, desc: '내장 mock 에이전트 대상으로 오프라인 실행: vulnerable | secure' },
  { name: 'yes', type: 'bool', value: true, path: 'authorized', commands: RP, desc: '소유하거나 테스트 권한이 있는 대상임을 확인 (실제 대상 필수)' },
  { name: 'dry-run', type: 'bool', value: true, path: null, commands: ['run'], desc: '계획·예상 요청 수만 출력 (요청 없음)' },
  { name: 'out', type: 'string', arg: '<file.md>', path: null, commands: ['run', 'compare'], desc: 'Markdown 리포트 저장' },
  { name: 'json', type: 'string', arg: '<file.json>', path: null, commands: ['run'], desc: 'JSON 리포트 저장' },
  { name: 'quiet', type: 'bool', value: true, path: null, commands: RP, desc: '진행 표시·케이스 줄 생략 (요약·카테고리·게이트만)' },
  { name: 'no-color', type: 'bool', value: true, path: null, commands: ALL, desc: '색 끔 (NO_COLOR 환경변수도 존중)' },
  { name: 'help', alias: 'h', short: true, type: 'bool', value: true, path: null, commands: ALL, desc: '도움말' },
  { name: 'version', type: 'bool', value: true, path: null, commands: ALL, desc: '버전 출력' },
]);

function usage(message) {
  return new ConfigError(message, [], 'USAGE');
}

function findFlag(token) {
  if (token === '-h') return FLAGS.find((f) => f.name === 'help');
  if (!token.startsWith('--')) return null;
  const name = token.slice(2);
  return FLAGS.find((f) => f.name === name || (f.alias && !f.short && f.alias === name)) || null;
}

function convert(flag, raw, token) {
  switch (flag.type) {
    case 'int':
      if (!/^-?\d+$/.test(raw)) throw usage(`${token} 값은 정수여야 합니다: ${raw}`);
      return Number(raw);
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) throw usage(`${token} 값은 숫자여야 합니다: ${raw}`);
      return n;
    }
    case 'csv':
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    case 'json': {
      let v;
      try { v = JSON.parse(raw); } catch (e) { throw usage(`${token} 값이 JSON이 아닙니다: ${jsonErrorText(e)}`); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw usage(`${token} 값은 JSON 객체여야 합니다`);
      return v;
    }
    default:
      if (flag.values && !flag.values.includes(raw)) throw usage(`${token} 값은 ${flag.values.join(' | ')} 중 하나여야 합니다: ${raw}`);
      return raw;
  }
}

/**
 * @returns {{command: string, flags: Record<string, any>, positionals: string[], help: boolean, version: boolean}}
 * flags are keyed by flag name (e.g. 'max-vulnerable'); bool flags hold their configured value.
 * @throws ConfigError code 'USAGE'
 */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const seen = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('-') || token === '-') { positionals.push(token); continue; }
    const eq = token.indexOf('=');
    const head = eq > 0 ? token.slice(0, eq) : token;
    const flag = findFlag(head);
    if (!flag) throw usage(`알 수 없는 플래그: ${head}`);
    seen.push({ flag, token: head });
    if (flag.type === 'bool') {
      if (eq > 0) throw usage(`${head}는 값을 받지 않습니다`);
      flags[flag.name] = flag.value;
      continue;
    }
    let raw;
    if (eq > 0) raw = token.slice(eq + 1);
    else {
      raw = argv[i + 1];
      if (raw === undefined || (raw.startsWith('--') && raw.length > 2)) throw usage(`${head} 값이 필요합니다`);
      i += 1;
    }
    flags[flag.name] = convert(flag, raw, head);
  }
  const help = Boolean(flags.help);
  const version = Boolean(flags.version);
  let command = 'run';
  if (positionals.length && COMMANDS.includes(positionals[0])) command = positionals.shift();
  if (!help && !version) {
    for (const { flag, token } of seen) {
      if (!flag.commands.includes(command)) throw usage(`${token}는 ${command} 명령에서 쓸 수 없습니다`);
    }
    if (command === 'compare') {
      if (positionals.length !== 2) throw usage('compare에는 <before.json> <after.json> 두 파일이 필요합니다');
    } else if (positionals.length) {
      throw usage(`알 수 없는 인자: ${positionals[0]}`);
    }
  }
  return { command, flags, positionals, help, version };
}

/** Map parsed flags to config overrides (dotted paths). */
export function flagsToOverrides(flags) {
  const o = {};
  for (const f of FLAGS) {
    if (!f.path || !(f.name in flags)) continue;
    o[f.path] = flags[f.name];
    if (f.enablesJudge) o['judge.enabled'] = true;
  }
  return o;
}

const CMD_TITLES = {
  run: 'run (기본) — 점검 실행 + 배포 게이트',
  probe: 'probe — 엔드포인트 사전 점검 (요청 최대 9회)',
  compare: 'compare <before.json> <after.json> — 폐루프 차단률',
  list: 'list — 프로브·변형 목록',
};

export function renderHelp(version) {
  const L = [];
  L.push(`agent-redteam ${version} — 배포 전 AI 에이전트 모의 해킹 · 배포 게이트`);
  L.push('');
  L.push('사용법:');
  L.push('  agent-redteam [run] [옵션]');
  L.push('  agent-redteam probe [옵션]');
  L.push('  agent-redteam compare <before.json> <after.json> [--out <file.md>]');
  L.push('  agent-redteam list');
  L.push('  agent-redteam --help | --version');
  const fmt = (f) => {
    const names = [f.short ? `-${f.alias}, --${f.name}` : `--${f.name}`];
    if (f.alias && !f.short) names.push(`--${f.alias}`);
    const left = `  ${names.join(', ')}${f.arg ? ' ' + f.arg : ''}`;
    return left.padEnd(36) + ' ' + f.desc;
  };
  L.push('');
  L.push('명령:');
  for (const cmd of COMMANDS) L.push(`  ${CMD_TITLES[cmd]}`);
  const groups = new Map();
  for (const f of FLAGS) {
    const key = f.commands === ALL ? '공통 (모든 명령)' : f.commands.join(' · ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [key, list] of groups) {
    L.push('');
    L.push(`옵션 — ${key}:`);
    for (const f of list) L.push(fmt(f));
  }
  L.push('');
  L.push('종료코드:');
  L.push('  0  run: 게이트 PASS · probe: fail 없음 · compare/list/help/version/dry-run 성공');
  L.push('  1  run: 게이트 FAIL (취약·오류·미결 기준) · probe: fail 1건 이상');
  L.push('  2  사용·설정 오류 (모르는 플래그, 설정 오류, 권한 미확인, 파일 읽기/쓰기 실패, 내부 오류)');
  L.push('');
  L.push('예시:');
  L.push('  node src/cli.mjs run --mock vulnerable');
  L.push('  node src/cli.mjs probe --config config.json --yes');
  L.push('  node src/cli.mjs run --config config.json --yes --repeats 3 --out report.md --json report.json');
  L.push('');
  L.push('⚠ 소유하거나 테스트 권한이 있는 대상에만 사용하십시오 (--yes 또는 설정 authorized:true).');
  return L.join('\n') + '\n';
}
