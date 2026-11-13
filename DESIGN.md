# Design

agent-redteam 사이트(랜딩·문서)와 웹 콘솔이 함께 쓰는 디자인 시스템. 원본은 `site/styles/tokens.css`(토큰)와 `site/styles/base.css`(공통 컴포넌트)이고, `site/build.mjs`가 글꼴과 합쳐 `_site/assets/system.css` 하나로 낸다. 콘솔은 `../assets/system.css` 위에 `web/console.css`만 얹는다.

## 세계관

배포 파이프라인 = 철도 연동(interlocking) 신호 제어반. 측정하지 못하면 신호는 적색으로 남는다(fail-safe = fail-closed).

- 라이트: 회녹색 에나멜 패널(`--enamel`) 위 검은 선로선. 다크: 슬레이트 패널.
- 신호등(`.lamp`)은 발광 없는 평면 렌즈 + 검은 테. 각인 명판(`.plate`)이 이름표. 터미널(`.term`)은 두 모드 모두 어둡다.
- 카드 그리드·그라디언트·글로우·색 왼쪽 띠를 쓰지 않는다. 섹션은 굵은 선로 rule(2px ink)로 나누고 명판이 그 선 위에 앉는다.

## 색은 신호다

| 토큰 | 뜻 |
|---|---|
| `--red` / `--red-lamp` / `--red-wash` | 공격·취약·FAIL |
| `--green` / `--green-lamp` / `--green-wash` | 차단·PASS |
| `--amber` / `--amber-lamp` / `--amber-wash` | 미결·사람 확인 필요 |
| `--ink`, `--ink-2`, `--ink-3`, `--paper`, `--paper-2`, `--surface`, `--enamel`, `--rule` | 중립 |

`-` 없는 이름은 글자용(AA), `-lamp`는 렌즈, `-wash`는 배경. 장식용 색을 더하지 않는다. 오류(ERROR)는 꺼진 렌즈 + 적색 테.

## 글꼴

Pretendard Variable(dynamic subset, `pretendard@1.3.9`)과 JetBrains Mono Variable(latin·latin-ext, `@fontsource-variable/jetbrains-mono@5.2.8`)을 자체 호스팅한다. 고정폭은 코드·ID(LLM01, caseId)·숫자 판독값에만 쓴다.

## 컴포넌트

- `.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-small` — 각진 스위치(2px radius).
- `.plate` `.plate-id` — 명판. `.lamp[data-v=VULNERABLE|BLOCKED|INCONCLUSIVE|ERROR|off]`, `.lamp.is-red|is-green|is-amber`.
- `.callout-info|warn|success|danger` — 1px 테두리 + wash + 신호등 제목.
- `.table-wrap` — 표는 자체 가로 스크롤, 위쪽 2px rule.
- `.term` `.term-bar` — 코드 블록. `site.js`가 복사 버튼을 붙인다.
- 랜딩 블록: `b-cards`(rule 위 열), `b-steps`(선로 위 역), `b-compare`(같은 축척의 전/후 패널), `b-stats`(판독 띠), `b-flow`(게이트 역에 신호기), `b-faq`, `b-links`.

## 규칙

- 라이트/다크 모두 대비 AA, 375px에서 가로 스크롤 없음, `prefers-reduced-motion`이면 전환 없음.
- 움직임은 하나: 방어 스위치를 누를 때 케이스 lamp가 한 번 차례로 켜지는 chase(`--chase-step`).
- 숫자는 손으로 쓰지 않는다. 빌드가 엔진을 mock으로 돌려 `data/demo.json`을 만든다.
