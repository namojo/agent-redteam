import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, TRANSFORMS, applyTransform, detectTransform, decodeTransform } from '../src/core/index.mjs';

const prompts = PROBES.flatMap((p) => p.turns);
const singles = PROBES.filter((p) => p.kind === 'single');

const roundTrip = (id, text, preserve = []) => {
  const out = applyTransform(id, text, { preserve });
  const det = detectTransform(out);
  assert.equal(det.id, id);
  return decodeTransform(id, det.payload);
};

test('none은 원문 그대로', () => {
  for (const p of prompts) assert.equal(applyTransform('none', p), p);
  assert.equal(detectTransform('평범한 문장'), null);
});

test('base64 한국어 UTF-8 왕복', () => {
  for (const p of prompts) assert.equal(roundTrip('base64', p), p);
  const enc = applyTransform('base64', '안녕');
  assert.equal(enc, TRANSFORMS.base64.prefix + '7JWI64WV');
});

test('rot13 두 번이면 원문', () => {
  for (const p of prompts) {
    const once = TRANSFORMS.rot13.encode(p);
    assert.equal(TRANSFORMS.rot13.encode(once), p);
    assert.equal(roundTrip('rot13', p), p);
  }
});

test('jamo: 모든 프로브 프롬프트 왕복', () => {
  for (const p of prompts) assert.equal(roundTrip('jamo', p), p);
  assert.equal(TRANSFORMS.jamo.encode('닭갈비'), 'ㄷㅏㄺㄱㅏㄹㅂㅣ');
  assert.equal(TRANSFORMS.jamo.decode('ㄷㅏㄺㄱㅏㄹㅂㅣ'), '닭갈비');
});

test('split: 모든 프로브 프롬프트 왕복', () => {
  for (const p of prompts) assert.equal(roundTrip('split', p), p);
  for (const p of singles) assert.equal(roundTrip('split', p.turns[0], p.sentinel ? [p.sentinel] : []), p.turns[0]);
  assert.equal(TRANSFORMS.split.encode('abcdefgh'), '[0]abcdef [1]gh');
});

test('leet·split·jamo는 sentinel 원형 보존', () => {
  for (const p of singles.filter((x) => x.sentinel)) {
    for (const id of ['leet', 'split', 'jamo']) {
      const out = applyTransform(id, p.turns[0], { preserve: [p.sentinel] });
      assert.ok(out.includes(p.sentinel), `${id} ${p.id}`);
    }
  }
  assert.equal(TRANSFORMS.leet.encode('sos RT-OK-1 sos', { preserve: ['RT-OK-1'] }), '505 RT-OK-1 505');
});

test('base64·rot13 결과에 RT- 토큰이 생기지 않음', () => {
  for (const p of singles) {
    for (const id of ['base64', 'rot13']) {
      const out = applyTransform(id, p.turns[0], { preserve: p.sentinel ? [p.sentinel] : [] });
      assert.ok(!/RT-[A-Z0-9]+(?:-[A-Z0-9]+)+/.test(out), `${id} ${p.id}`);
    }
  }
});

test('detectTransform이 각 prefix 인식', () => {
  for (const id of ['base64', 'rot13', 'leet', 'split', 'jamo']) {
    const out = applyTransform(id, 'hello 안녕');
    assert.deepEqual(detectTransform(out), { id, payload: out.slice(TRANSFORMS[id].prefix.length) });
  }
});

test('알 수 없는 변형은 오류', () => {
  assert.throws(() => applyTransform('morse', 'x'), /unknown transform/);
  assert.throws(() => decodeTransform('morse', 'x'), /unknown transform/);
});
