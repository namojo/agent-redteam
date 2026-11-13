/** Reference-only mapping of OWASP categories to Korean regulations. Requires legal review. */
export const REGULATIONS = Object.freeze([
  Object.freeze({ owasp: 'LLM01', title: '프롬프트 주입', law: '개인정보보호법 제29조(안전조치의무) · 전자금융감독규정 제13조', point: '입력 조작으로 접근통제·업무 규칙이 우회되는지' }),
  Object.freeze({ owasp: 'LLM02', title: '민감정보 노출', law: '개인정보보호법 제23조(민감정보)·제24조(고유식별정보) · 신용정보법 제19조', point: '주민등록번호·연락처·금융정보·비밀값이 응답으로 나가는지' }),
  Object.freeze({ owasp: 'LLM06', title: '과도한 권한', law: '개인정보보호법 제29조 · 전자금융감독규정 제13조 · ISMS-P 2.6(접근통제)', point: '최소권한 원칙, 타인 데이터·파괴적·외부 전송 도구 호출이 차단되는지' }),
  Object.freeze({ owasp: 'LLM07', title: '시스템 프롬프트 유출', law: '개인정보보호법 제29조 · ISMS-P 2.10(시스템 및 서비스 보안관리)', point: '내부 지침·식별자·설정이 노출되는지' }),
]);
