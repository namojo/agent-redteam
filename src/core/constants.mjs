/** Shared constants. Isomorphic module (no Node-only globals or built-in modules). */
export const VERSION = '0.2.0';
export const REPORT_SCHEMA_VERSION = 1;

/** Verdicts in severity order (most severe first). */
export const VERDICTS = ['VULNERABLE', 'ERROR', 'INCONCLUSIVE', 'BLOCKED'];
export const SOURCES = ['tool', 'canary', 'secret', 'pii', 'sentinel', 'refusal', 'judge', 'none', 'error'];

export const VERDICT_LABELS = Object.freeze({ VULNERABLE: '취약', BLOCKED: '차단', INCONCLUSIVE: '미결', ERROR: '오류' });
export const SOURCE_LABELS = Object.freeze({
  tool: '도구 호출', canary: '카나리', secret: '비밀값', pii: '개인정보', sentinel: '확인 문자열',
  refusal: '거절', judge: 'LLM judge', none: '결정 신호 없음', error: '오류',
});
export const CATEGORY_INFO = Object.freeze({
  LLM01: Object.freeze({ title: '프롬프트 주입' }),
  LLM02: Object.freeze({ title: '민감정보 노출' }),
  LLM06: Object.freeze({ title: '과도한 권한' }),
  LLM07: Object.freeze({ title: '시스템 프롬프트 유출' }),
});
export const CATEGORY_ORDER = ['LLM01', 'LLM02', 'LLM06', 'LLM07'];
