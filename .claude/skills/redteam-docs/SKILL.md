---
name: redteam-docs
description: agent-redteam 한국어 문서(README, MANUAL, ARCHITECTURE, OFFLINE-INSTALL, EXAMPLE-REPORT) 작성·수정 규칙 — 구현 상태 정직 표기, 실행해 본 명령만 싣기, 공개 저장소 위생(회사·제품명·사내 주소·키 금지), Mermaid 안전 규칙. agent-redteam 문서를 쓰거나 고치거나 README 주장과 코드가 맞는지 점검할 때 반드시 사용.
---

# agent-redteam 문서 규칙

## 1. 독자와 톤
- 독자: 사내 AI 에이전트를 배포 전에 점검하려는 보안·개발 담당자. 한국어로 쓰고, 코드·식별자·명령은 원문 그대로.
- 먼저 결론과 사용법, 그다음 원리. 홍보 문구보다 "무엇을 확인할 수 있고 무엇은 못 하는지".

## 2. 정직한 상태 표기
- README에 **기능 상태 표**를 둔다: 기능 / 상태(구현·부분·로드맵) / 비고. 미구현을 숨기면 사용자가 도구를 과신해 배포 판단을 그르친다.
- 다른 도구(garak·promptfoo·PyRIT·DeepTeam 등)와 비교할 때는 확인 가능한 사실만 쓰고 단정적 우열 표현을 피한다.
- 판정의 한계(정규식·judge 오탐, 비결정성, 반복 수가 적을 때 CI가 넓음)를 MANUAL "결과 해석"에 쓴다.

## 3. 명령 예시
- 문서의 모든 명령은 실제로 돌려 본 것만. 출력 예시는 실제 출력에서 잘라 쓴다.
- 예시 리포트(`docs/EXAMPLE-REPORT.md`)는 mock 에이전트 실행 결과로 생성한다(손으로 쓰지 않는다). 생성 명령을 문서 상단에 적는다.
- 엔드포인트 예시는 `https://agent.example.com`, `https://llm-gateway.example.internal/v1` 같은 예약 도메인만.

## 4. 공개 저장소 위생 (push 전 필수)
- 특정 회사·계열사·사내 제품/플랫폼 이름을 쓰지 않는다. "국내 기업", "사내 에이전트 플랫폼", "사내 OpenAI 호환 LLM(DeepSeek·GLM 등 오픈 모델)"처럼 일반화한다. 오픈 모델명(DeepSeek, GLM)과 공개 표준(OWASP, ISMS-P, 법령명)은 써도 된다.
- 사내 URL·IP·키·실제 개인정보 금지. 예시 PII는 명백한 가짜(`900101-1234567` 등)만.
- 검사: `node .claude/skills/redteam-qa/scripts/hygiene.mjs` (로컬 `.hygiene-denylist.txt`가 있으면 그 단어도 검사).

## 5. 문서 구성
| 파일 | 내용 |
|---|---|
| README.md | 한 줄 소개, 기능 상태 표, 빠른 시작(npm test → mock → 내 에이전트), 동작 원리 다이어그램 1개, 문서 링크, 안전·권한 |
| docs/MANUAL.md | 설치, 대상 연결(provider별), probe, CLI·설정 레퍼런스(코드와 1:1), 공격 옵션, judge 보정, 결과 해석, CI 게이트, 웹 콘솔, 트러블슈팅, FAQ |
| docs/ARCHITECTURE.md | 모듈 구조, 판정 모델(결정 트리 다이어그램), 게이트, 데이터 흐름, 확장 방법 |
| docs/OFFLINE-INSTALL.md | 폐쇄망 반입(`npm pack` tarball·zip), Node 버전, 사내 CA, 프록시, 자체 점검 |
| docs/EXAMPLE-REPORT.md | mock 실행으로 생성한 리포트 |

## 6. Mermaid
- 노드 라벨은 `["…"]`로 감싼다. 엣지 라벨 `|…|`에 `>`, `<`, `≤`, `≥`, 따옴표, 괄호를 쓰지 않는다("이하", "초과" 같은 말로).
- 다이어그램은 문서당 꼭 필요한 것만. 사이트 빌드 후 렌더 확인은 web-developer/QA가 한다.

## 7. 규제 매핑
- 조문은 참고용이며 법무 검토가 필요하다는 단서를 붙인다. OWASP 번호는 2025판 기준(LLM01 주입, LLM02 민감정보, LLM06 과도한 권한, LLM07 시스템 프롬프트 유출).
