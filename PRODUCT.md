# Product

<!-- impeccable:product-schema 1 -->

> 이 파일의 사실은 저장소(README 기능 상태 표, 코드)에서 **추론**한 것이다. 사용자 인터뷰 없이 작성됐으므로 틀린 항목은 고쳐 쓴다.

## Platform

web

## Users

- 국내 기업에서 사내 에이전트 플랫폼·사내 OpenAI 호환 LLM으로 만든 에이전트를 운영에 올리기 전에 점검하는 보안·개발 담당자.
- 사내 해커톤("에이전트 모의 해킹") 심사위원 — 3분 안에 문제→해법→데모→증거를 이해해야 한다.

## Product Purpose

배포 전 AI 에이전트에 한국어 공격 프롬프트를 보내고, 결정적 오라클로 판정해 CI 종료코드(배포 게이트 0 PASS · 1 FAIL · 2 설정 오류)로 돌려준다. 방어 가드를 적용한 뒤 같은 공격을 다시 돌려 차단률을 비교하는 폐루프를 제공한다.

## Positioning

범용 LLM 레드팀 도구(garak·promptfoo·PyRIT)를 대체하지 않는다. 한국어 프로브, 국내 PII 오라클(주민등록번호·휴대폰·카드), fail-closed 배포 게이트, 사내 OpenAI 호환 엔드포인트 quirk 흡수, 런타임 의존성 0(폐쇄망)에 초점을 둔 작은 하네스다.

## Operating Context

CLI(`node src/cli.mjs`)와 CI 파이프라인의 배포 단계, 폐쇄망 설치, 브라우저 웹 콘솔(mock 데모 · CORS 허용 대상 실제 연결), GitHub Pages 문서 사이트.

## Capabilities and Constraints

- 프로브 17종(단일 14 + 멀티턴 크레센도 3), OWASP LLM Top 10 2025의 LLM01·LLM02·LLM06·LLM07. 인코딩 변형 5종.
- 판정: 결정적 오라클 우선, LLM judge는 보조이며 오탐률·κ를 공개.
- 사이트 숫자는 빌드 때 엔진을 mock으로 실제 실행해 만든다. 손으로 쓴 숫자 금지.
- 공개 저장소: 회사·제품명·사내 주소·키 금지. 사이트 자산은 자체 호스팅(CDN 금지).

## Brand Commitments

이름 `agent-redteam`(소문자). 색은 의미를 가진다: 공격·취약·FAIL = red, 차단·PASS = green, 미결 = amber, 중립 = ink/slate. 문체는 한국어, 과장 없이 사실만.

## Evidence on Hand

빌드 시 생성되는 `_site/data/demo.json`(mock 실행 결과), 예시 리포트(`docs/EXAMPLE-REPORT.md`). 고객사·도입 사례·외부 벤치마크는 없다 — 만들어 내지 않는다.

## Product Principles

1. 측정하지 못한 것은 통과가 아니다(fail-closed).
2. 구현된 것만 주장하고, 나머지는 로드맵이라고 쓴다.
3. 사내망·폐쇄망에서도 똑같이 동작하고 똑같이 보인다.

## Accessibility & Inclusion

라이트/다크 모두 WCAG AA 대비, 375px에서 가로 스크롤 없음, `prefers-reduced-motion` 존중, 키보드 접근.
