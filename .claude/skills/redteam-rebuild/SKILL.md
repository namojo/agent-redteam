---
name: redteam-rebuild
description: agent-redteam 개선 하네스 오케스트레이터 — 설계(redteam-architect) → 엔진 구현(engine-developer) → 웹 콘솔·Pages 사이트(web-developer)와 문서(docs-writer) 병렬 → 통합 검증(qa-verifier) → 수정 루프를 조율한다. agent-redteam 재구축, 현황 분석, 기능 추가·개선, 판정 정확도 개선, 문서·사이트 갱신, 릴리스 전 점검을 요청받으면 반드시 사용. 후속 작업: 결과 수정, 부분 재실행(엔진만·문서만·사이트만·QA만 다시), 업데이트, 보완, 다시 실행, 이전 결과 개선 요청에도 사용.
---

# agent-redteam 개선 오케스트레이터

## 실행 모드: 서브 에이전트 (파이프라인 + 중간 팬아웃)

팀 도구(TeamCreate/SendMessage)가 없는 환경을 기본으로 한다. 에이전트 간 데이터는 `_workspace/` 파일로 넘기고, 오케스트레이터(메인 세션)가 순서와 재호출을 결정한다. 팀 도구가 있는 환경이면 Phase 3을 에이전트 팀으로 바꿔도 된다(web-developer ↔ docs-writer가 링크 규칙을 직접 조율).

## 에이전트 구성

| 에이전트 | subagent_type | 스킬 | 출력 |
|---|---|---|---|
| redteam-architect | general-purpose | redteam-engine | `_workspace/01_architect_spec.md` |
| engine-developer | general-purpose | redteam-engine | 코드 + `_workspace/02_engine_notes.md` |
| web-developer | general-purpose | redteam-site | `web/`, `site/`, pages.yml + `_workspace/03_web_notes.md` |
| docs-writer | general-purpose | redteam-docs | 문서 + `_workspace/03_docs_notes.md` |
| qa-verifier | general-purpose | redteam-qa | `_workspace/04_qa_report.md` |

모든 Agent 호출에 `model: "opus"`를 명시한다. 프롬프트에는 "`.claude/agents/{name}.md`를 읽고 그 역할로 일하라, `.claude/skills/{skill}/SKILL.md`를 따르라"와 이번 실행의 입력 경로·범위를 넣는다. 역할 설명을 프롬프트에 다시 쓰지 않는다 — 정의 파일이 원본이다.

## 워크플로우

### Phase 0: 컨텍스트 확인
1. `_workspace/` 확인.
   - 없음 → 초기 실행.
   - 있음 + 부분 수정 요청("문서만", "사이트만", "판정 규칙만") → 해당 에이전트만 재호출하고 이후 QA만 다시.
   - 있음 + 새 목표 → `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 옮기고 초기 실행.
2. 작업 트리가 깨끗한지(`git status`) 확인한다. 사용자의 미커밋 변경이 있으면 덮어쓰지 말고 먼저 묻는다.

### Phase 1: 입력 정리 (오케스트레이터)
`_workspace/00_input/brief.md`에 쓴다: 사용자 목표와 결정, 현황 분석(README 약속 vs 구현, 버그), 범위 밖 항목, 제약(공개 저장소, force-push 금지, push·Pages 활성화는 사용자 승인 후).

### Phase 2: 설계
redteam-architect 1회. 명세를 받으면 오케스트레이터가 범위가 사용자 결정과 맞는지 확인한다. 크게 바뀌는 결정(스택 변경, 사용자 접점 비호환)이 있으면 사용자에게 확인받고 진행한다.

### Phase 3: 구현
1. engine-developer (core API가 웹·문서의 전제이므로 먼저). 끝나면 오케스트레이터가 `npm test`를 직접 돌려 확인한다.
2. QA 1차(엔진 범위만) — 판정·게이트 결함은 여기서 잡는다.
3. web-developer와 docs-writer를 **병렬**(`run_in_background: true`, 한 메시지에서 두 호출). 둘은 서로 다른 파일만 만진다: web은 `web/ site/ .github/workflows/pages.yml package*.json`, docs는 `README.md docs/`.

### Phase 4: 통합 검증
qa-verifier 전체 범위. 결함이 있으면 담당 에이전트를 결함 ID와 함께 재호출 → QA 재검증. 최대 2회 반복, 그래도 남으면 사용자에게 남은 결함을 보고하고 판단을 받는다.

### Phase 5: 마무리 (오케스트레이터)
1. 직접 확인: `npm test`, 위생 검사, 사이트 빌드·브라우저 렌더 확인.
2. 논리 단위로 커밋(영어 메시지). push·Pages 활성화 전에 변경 요약을 보여 주고 승인받는다.
3. push 후 CI·Pages 배포 결과와 실제 사이트(다이어그램 렌더 포함)를 확인한다.
4. CLAUDE.md 변경 이력 갱신, 사용자에게 한국어로 결과·남은 일 보고, 피드백 요청.

## 데이터 흐름

```
brief.md → [architect] → 01_spec → [engine] → 02_engine_notes + 코드
                                        ↓
                                 [QA 1차: 엔진]
                                        ↓
                    ┌──────── [web] → 03_web_notes + web/ site/
                    └──────── [docs] → 03_docs_notes + docs/
                                        ↓
                                 [QA 전체] → 04_qa_report
                                        ↓ 결함
                                 해당 에이전트 재호출
```

## 에러 핸들링

| 상황 | 대응 |
|---|---|
| 에이전트 실패·중단 | 같은 입력으로 1회 재시도. 재실패 시 그 범위를 오케스트레이터가 직접 하거나 사용자에게 보고 |
| 명세와 구현 불일치 | QA가 판정, 코드가 맞으면 명세의 결정 기록 갱신 |
| `npm test` 실패 상태로 Phase 3-3 진입 금지 | 엔진을 먼저 고친다 |
| 병렬 에이전트가 같은 파일 수정 | 파일 소유권 표(Phase 3-3) 위반 — 뒤에 쓴 쪽 변경을 검토 후 병합 |
| 네트워크 필요 작업(npm install, gh) 실패 | 원인과 재현 명령을 보고, 오프라인 대체 경로 검토 |

## 테스트 시나리오

**정상 흐름**: "agent-redteam 처음부터 재검토해서 다시 만들어 줘" → Phase 0 초기 실행 → brief → spec → 엔진+테스트 그린 → QA 1차 통과 → web·docs 병렬 → QA 전체 결함 2건 → docs 재호출 → QA 통과 → 커밋 → 승인 → push → Pages 확인.

**에러 흐름**: QA가 "엔드포인트 전부 500인데 게이트 PASS"(차단 결함) 보고 → engine-developer를 결함 ID와 재호출 → 회귀 테스트 추가 확인 → QA 재검증 통과. 2회 반복 후에도 남으면 사용자에게 결함과 선택지를 보고.

**부분 재실행**: "다이어그램이 사이트에서 깨져" → Phase 0에서 web-developer만 재호출(redteam-site 3절) → QA 사이트 항목만 재검증.
