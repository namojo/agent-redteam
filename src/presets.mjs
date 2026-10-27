/** 엔드포인트 프리셋 — 흔한 대상의 요청/응답 모양 */
export const PRESETS = {
  // Anthropic Messages API (멀티턴 {{MESSAGES}} 지원)
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: '{"x-api-key":"{{KEY}}","anthropic-version":"2023-06-01","content-type":"application/json"}',
    body: '{"model":"claude-haiku-4-5","max_tokens":512,"system":"{{SYSTEM}}","messages":[{{MESSAGES}}]}',
    responsePath: 'content.0.text',
  },
  // OpenAI 호환 Chat Completions (멀티턴 {{MESSAGES}} 지원)
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: '{"Authorization":"Bearer {{KEY}}","content-type":"application/json"}',
    body: '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"{{SYSTEM}}"},{{MESSAGES}}]}',
    responsePath: 'choices.0.message.content',
  },
  // 커스텀 에이전트 (단일턴). 멀티턴을 쓰려면 body를 {{MESSAGES}} 형태로 바꾸세요.
  custom: {
    url: '',
    method: 'POST',
    headers: '{"content-type":"application/json"}',
    body: '{"system":"{{SYSTEM}}","message":"{{PROMPT}}"}',
    responsePath: 'reply',
  },
};
