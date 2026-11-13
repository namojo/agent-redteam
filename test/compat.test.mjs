import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, extractJson, getPath, composeSystem, PROBE_TOOLS, GUARD_PROMPT } from '../src/core/index.mjs';

const OPENAI = {
  provider: 'openai', url: 'https://llm.example.test/v1/chat/completions', model: 'm', apiKey: '', headers: {}, systemRole: 'system',
  systemPrompt: '', temperature: 0, maxTokens: null, extraBody: {}, sendTools: true, method: 'POST', body: '', responsePath: '', toolCallsPath: '',
};
const ANTH = { ...OPENAI, provider: 'anthropic', url: 'https://api.example.test/v1/messages', maxTokens: 1024 };
const HTTP = { ...OPENAI, provider: 'http', url: 'https://agent.example.test/chat', body: '{"system":"{{SYSTEM}}","message":"{{PROMPT}}"}', responsePath: 'reply' };
const user = (c) => [{ role: 'user', content: c }];
const body = (req) => JSON.parse(req.body);
const res = (obj, status = 200) => ({ status, headers: {}, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });

test('openai: systemRole system/developer/user-prefix 배치', () => {
  const s = body(buildRequest(OPENAI, { system: 'SYS', messages: user('hi') }));
  assert.deepEqual(s.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
  const d = body(buildRequest({ ...OPENAI, systemRole: 'developer' }, { system: 'SYS', messages: user('hi') }));
  assert.equal(d.messages[0].role, 'developer');
  const u = body(buildRequest({ ...OPENAI, systemRole: 'user-prefix' }, { system: 'SYS', messages: [...user('a'), { role: 'assistant', content: 'b' }, ...user('c')] }));
  assert.equal(u.messages.length, 3);
  assert.equal(u.messages[0].content, '[시스템 지시]\nSYS\n[/시스템 지시]\n\na');
  assert.equal(u.messages[2].content, 'c');
});

test('openai: 빈 system 생략', () => {
  const b = body(buildRequest(OPENAI, { system: '', messages: user('hi') }));
  assert.deepEqual(b.messages, [{ role: 'user', content: 'hi' }]);
});

test('openai: content는 문자열', () => {
  const b = body(buildRequest(OPENAI, { system: 'S', messages: user('hi') }));
  for (const m of b.messages) assert.equal(typeof m.content, 'string');
});

test('openai: temperature 0 전송·null 미전송', () => {
  assert.equal(body(buildRequest(OPENAI, { messages: user('x') })).temperature, 0);
  assert.ok(!('temperature' in body(buildRequest({ ...OPENAI, temperature: null }, { messages: user('x') }))));
});

test('openai: max_tokens null 미전송', () => {
  assert.ok(!('max_tokens' in body(buildRequest(OPENAI, { messages: user('x') }))));
  assert.equal(body(buildRequest({ ...OPENAI, maxTokens: 64 }, { messages: user('x') })).max_tokens, 64);
});

test('openai: extraBody 병합과 코어 필드 우선', () => {
  const b = body(buildRequest({ ...OPENAI, extraBody: { model: 'evil', temperature: 1, chat_template_kwargs: { enable_thinking: false } } }, { messages: user('x') }));
  assert.equal(b.model, 'm');
  assert.equal(b.temperature, 0);
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
});

test('openai: tools 형식', () => {
  const b = body(buildRequest(OPENAI, { messages: user('x'), tools: PROBE_TOOLS }));
  assert.equal(b.tools.length, 3);
  assert.deepEqual(b.tools[0], { type: 'function', function: { name: 'get_salary', description: PROBE_TOOLS[0].description, parameters: PROBE_TOOLS[0].parameters } });
  assert.ok(!('tool_choice' in b));
  assert.ok(!('tools' in body(buildRequest(OPENAI, { messages: user('x'), tools: null }))));
});

test('openai: apiKey → authorization 헤더, 사용자 헤더 우선', () => {
  const r1 = buildRequest({ ...OPENAI, apiKey: 'k-123456' }, { messages: user('x') });
  assert.equal(r1.headers.authorization, 'Bearer k-123456');
  assert.equal(r1.headers['content-type'], 'application/json');
  const r2 = buildRequest({ ...OPENAI, apiKey: 'k-123456', headers: { Authorization: 'Custom z', 'X-Gw': 'g' } }, { messages: user('x') });
  assert.equal(r2.headers.authorization, 'Custom z');
  assert.equal(r2.headers['x-gw'], 'g');
  const r3 = buildRequest({ ...OPENAI, apiKey: 'k-123456', headers: { 'x-api-key': '{{KEY}}' } }, { messages: user('x') });
  assert.equal(r3.headers['x-api-key'], 'k-123456', '{{KEY}} in headers works for every provider');
  const r4 = buildRequest({ ...ANTH, apiKey: 'ak-9999', headers: { 'x-gw': 'Bearer {{KEY}}' } }, { messages: user('x') });
  assert.equal(r4.headers['x-gw'], 'Bearer ak-9999');
  assert.equal(r1.method, 'POST');
  assert.equal(r1.url, OPENAI.url);
});

test('anthropic: system top-level·max_tokens 기본 1024·헤더', () => {
  const r = buildRequest({ ...ANTH, apiKey: 'ak-1234' }, { system: 'SYS', messages: user('hi'), tools: PROBE_TOOLS });
  const b = body(r);
  assert.equal(b.system, 'SYS');
  assert.equal(b.max_tokens, 1024);
  assert.deepEqual(b.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(b.tools[0].input_schema.type, 'object');
  assert.equal(r.headers['x-api-key'], 'ak-1234');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.ok(!('system' in body(buildRequest(ANTH, { system: '', messages: user('hi') }))));
  assert.equal(body(buildRequest({ ...ANTH, maxTokens: null }, { messages: user('hi') })).max_tokens, 1024);
});

test('anthropic: tool_use 파싱', () => {
  const out = parseResponse(ANTH, res({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'tool_use', id: 't1', name: 'get_salary', input: { employee: '이도윤' } }] }));
  assert.equal(out.text, 'a\nb');
  assert.deepEqual(out.toolCalls, [{ id: 't1', name: 'get_salary', arguments: { employee: '이도윤' } }]);
  assert.throws(() => parseResponse(ANTH, res({ content: 'x' })), (e) => e.code === 'PARSE');
});

test('http: 플레이스홀더 치환과 JSON 이스케이프(따옴표·개행·한국어)', () => {
  const r = buildRequest(HTTP, { system: '시스템 "따옴표"', messages: user('줄1\n줄2 "q" \\ 끝') });
  const b = body(r);
  assert.equal(b.system, '시스템 "따옴표"');
  assert.equal(b.message, '줄1\n줄2 "q" \\ 끝');
  assert.equal(r.headers['content-type'], 'application/json');
});

test('http: {{MESSAGES}} 다중 턴', () => {
  const t = { ...HTTP, body: '{"messages":[{{MESSAGES}}]}' };
  const b = body(buildRequest(t, { messages: [...user('a'), { role: 'assistant', content: 'b "x"' }, ...user('c')] }));
  assert.deepEqual(b.messages, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b "x"' }, { role: 'user', content: 'c' }]);
});

test('http: {{KEY}} 헤더 치환', () => {
  const r = buildRequest({ ...HTTP, apiKey: 'key-9876', headers: { 'X-Api-Key': '{{KEY}}', authorization: 'Bearer {{KEY}}' } }, { messages: user('x') });
  assert.equal(r.headers['x-api-key'], 'key-9876');
  assert.equal(r.headers.authorization, 'Bearer key-9876');
});

test('http: GET은 본문 없음', () => {
  const r = buildRequest({ ...HTTP, method: 'GET' }, { messages: user('x') });
  assert.equal(r.method, 'GET');
  assert.equal(r.body, undefined);
});

test('composeSystem: systemPrompt + defend 가드', () => {
  assert.equal(composeSystem({ target: { systemPrompt: 'A' }, attack: { defend: false } }), 'A');
  assert.equal(composeSystem({ target: { systemPrompt: 'A' }, attack: { defend: true } }), 'A\n\n' + GUARD_PROMPT);
  assert.equal(composeSystem({ target: { systemPrompt: '' }, attack: { defend: true } }), GUARD_PROMPT);
  assert.equal(composeSystem({ target: { systemPrompt: '' }, attack: { defend: false } }), '');
});

test('parseResponse: openai content null + tool_calls', () => {
  const out = parseResponse(OPENAI, res({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delete_records', arguments: '{"scope":"all"}' } }] } }] }));
  assert.equal(out.text, '');
  assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'delete_records', arguments: { scope: 'all' } }]);
});

test('parseResponse: content 배열 파트', () => {
  const out = parseResponse(OPENAI, res({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }));
  assert.equal(out.text, 'ab');
});

test('parseResponse: function_call 레거시', () => {
  const out = parseResponse(OPENAI, res({ choices: [{ message: { content: '', function_call: { name: 'send_email', arguments: '{"to":"a@b"}' } } }] }));
  assert.deepEqual(out.toolCalls, [{ id: null, name: 'send_email', arguments: { to: 'a@b' } }]);
});

test('parseResponse: arguments JSON 실패 → _raw', () => {
  const out = parseResponse(OPENAI, res({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{bad' } }] } }] }));
  assert.deepEqual(out.toolCalls[0].arguments, { _raw: '{bad' });
});

test('parseResponse: choices 비면 PARSE', () => {
  assert.throws(() => parseResponse(OPENAI, res({ choices: [] })), (e) => e.code === 'PARSE');
  assert.throws(() => parseResponse(OPENAI, res({ error: 'x' })), (e) => e.code === 'PARSE');
});

test('parseResponse: 비JSON → PARSE', () => {
  assert.throws(() => parseResponse(OPENAI, res('<html>bad gateway</html>')), (e) => e.code === 'PARSE');
  assert.throws(() => parseResponse(HTTP, res('<html>')), (e) => e.code === 'PARSE');
});

test('parseResponse: http responsePath 중첩·배열 인덱스·대괄호 표기', () => {
  const payload = { data: { items: [{ text: '첫째' }, { text: '둘째' }] } };
  assert.equal(parseResponse({ ...HTTP, responsePath: 'data.items.1.text' }, res(payload)).text, '둘째');
  assert.equal(parseResponse({ ...HTTP, responsePath: 'data.items[0].text' }, res(payload)).text, '첫째');
  assert.equal(parseResponse({ ...HTTP, responsePath: 'data.items' }, res(payload)).text, JSON.stringify(payload.data.items));
});

test('parseResponse: 경로 없음 → RESPONSE_PATH', () => {
  assert.throws(() => parseResponse({ ...HTTP, responsePath: 'nope.x' }, res({ reply: 'a' })), (e) => e.code === 'RESPONSE_PATH' && /nope\.x/.test(e.message));
  assert.throws(() => parseResponse({ ...HTTP, responsePath: 'reply' }, res({ reply: null })), (e) => e.code === 'RESPONSE_PATH');
});

test('parseResponse: responsePath 빈 값 → 원문', () => {
  assert.equal(parseResponse({ ...HTTP, responsePath: '' }, res('plain text 응답')).text, 'plain text 응답');
});

test('parseResponse: toolCallsPath 정규화(OpenAI형·평면형)', () => {
  const t = { ...HTTP, toolCallsPath: 'calls' };
  const out = parseResponse(t, res({
    reply: 'ok',
    calls: [
      { id: 'a', type: 'function', function: { name: 'get_salary', arguments: '{"employee":"이도윤"}' } },
      { name: 'send_email', args: { to: 'x@external.example' } },
      { input: { nameless: true } },
    ],
  }));
  assert.deepEqual(out.toolCalls.map((c) => [c.name, c.arguments]), [['get_salary', { employee: '이도윤' }], ['send_email', { to: 'x@external.example' }]]);
  assert.deepEqual(parseResponse({ ...HTTP, toolCallsPath: 'missing' }, res({ reply: 'ok' })).toolCalls, []);
  assert.deepEqual(parseResponse({ ...HTTP, toolCallsPath: 'reply' }, res({ reply: 'ok' })).toolCalls, []);
});

test('getPath: 빈 경로·null 중간값', () => {
  const o = { a: { b: null } };
  assert.equal(getPath(o, ''), o);
  assert.equal(getPath(o, 'a.b.c'), undefined);
  assert.equal(getPath({ a: [{ b: 1 }] }, 'a[0].b'), 1);
});

test('extractJson: 펜스', () => {
  assert.deepEqual(extractJson('```json\n{"verdict":"blocked"}\n```'), { verdict: 'blocked' });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: 앞뒤 설명문', () => {
  assert.deepEqual(extractJson('판정 결과는 다음과 같습니다: {"verdict":"vulnerable","reason":"x"} 이상입니다.'), { verdict: 'vulnerable', reason: 'x' });
});

test('extractJson: think 접두', () => {
  assert.deepEqual(extractJson('<think>{"verdict":"wrong"}</think>{"verdict":"blocked"}'), { verdict: 'blocked' });
});

test('extractJson: 잘못된 JSON → null', () => {
  assert.equal(extractJson('{not json'), null);
  assert.equal(extractJson('그냥 문장'), null);
  assert.equal(extractJson('42'), null);
  assert.equal(extractJson(null), null);
});
