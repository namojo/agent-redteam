---
name: redteam-site
description: agent-redteam 웹 콘솔(web/)과 GitHub Pages 사이트(site/ 빌드, Markdown→HTML, Mermaid 다이어그램 렌더링, pages.yml 배포) 구현·수정·검증 규칙. 웹 콘솔, Pages, 사이트, 다이어그램 깨짐, 문서 사이트 빌드, namojo.github.io/agent-redteam 관련 작업이면 반드시 사용.
---

# 웹 콘솔과 Pages 사이트

## 1. 산출물 구조

```
web/                 웹 콘솔 (ES 모듈, 번들 없음. 스타일은 빌드된 ../assets/system.css를 쓰므로 빌드된 사이트로 본다)
  index.html
  console.mjs        src/core/를 상대 경로로 import
  console.css
site/
  build.mjs          랜딩 + docs/*.md·README → _site/*.html, web/·src/core/ 복사, Mermaid·글꼴 자산 복사
  demo.mjs           빌드 때 엔진을 mock으로 실행해 _site/data/demo.json 생성 (랜딩 숫자의 원본)
  landing.html       랜딩 템플릿 (카피는 content/landing.json)
  content/landing.json  랜딩 카피 (docs-writer 소유)
  template.html      문서 페이지 레이아웃 (사이드 목차)
  styles/            tokens.css(디자인 토큰 단일 원본) · base.css · landing.css · docs.css → assets/system.css
  client/            랜딩·문서용 소형 스크립트
_site/               빌드 결과 (gitignore)
.github/workflows/pages.yml
```

사이트 URL 구조: `/` 랜딩, `/readme.html` 개요(README), `/manual.html`, `/architecture.html`, `/offline-install.html`, `/example-report.html`, `/console/` 웹 콘솔. 실제 파일명은 build.mjs의 매핑 표 하나에서 관리한다. 디자인 결정의 배경은 루트 `DESIGN.md`.

## 1-1. 디자인 시스템 (사이트·콘솔 공통)

사이트는 "문서를 HTML로 바꾼 것"이 아니라 **해커톤 심사위원·보안 담당자가 3분 안에 문제→해법→증거를 이해하는 제품 페이지**다.
- 랜딩(`index.html`)은 README 렌더가 아니라 `site/landing.html` 전용 템플릿이다. 카피 원본은 `site/content/landing.json`(docs-writer 소유) 하나에서 읽는다. 레이아웃은 web-developer, 문장은 docs-writer.
- 숫자(케이스 수, 취약·차단 건수, 차단률, 프로브 목록)는 **빌드 때 엔진을 mock 대상으로 실제 실행해** `_site/data/demo.json`을 만들어 채운다. 손으로 쓴 숫자는 코드와 어긋난다.
- 색은 의미를 가진다: 공격·취약·FAIL = signal red, 차단·PASS = green, 미결 = amber, 중립 = ink/slate. 장식용 색을 늘리지 않는다. 토큰은 `:root` CSS 변수 하나에서 관리하고 콘솔도 같은 토큰을 쓴다.
- 글꼴은 자체 호스팅(CDN 금지 — 사내망·폐쇄망에서도 같게 보이도록). 한글 본문은 Pretendard 계열, 코드는 고정폭. woff2만, 필요한 굵기만.
- 라이트/다크 모두 대비 WCAG AA, 375px에서 가로 스크롤 없음, `prefers-reduced-motion`이면 애니메이션 끔.
- 문서 페이지는 같은 시스템을 쓴다: 데스크톱에서 왼쪽(또는 오른쪽) 고정 목차, 읽기 폭 70ch 안팎, 표는 자체 스크롤, 콜아웃 스타일.

## 2. 빌드 원칙

- Markdown 변환은 빌드 시점에 한다(`marked`, 버전 고정 `--save-exact`). 빌드 의존성은 **`site/package.json`·`site/package-lock.json`에만** 둔다 — 루트 `package.json`은 devDependencies까지 0개로 유지해 도구 반입(`npm pack`)과 엔진 작업에 영향을 주지 않는다. 설치는 `npm ci --prefix site`.
- **Mermaid는 CDN이 아니라 사이트에 자체 호스팅**한다: 빌드가 `node_modules/mermaid/dist/mermaid.min.js`를 `_site/assets/`로 복사. 사내망에서 CDN이 막혀도 다이어그램이 보이고, 버전이 고정된다.
- ```` ```mermaid ```` 코드 블록은 `<pre class="mermaid">`(HTML 이스케이프한 원문)로 바꾸고 `mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' })`. 다크 모드면 `theme: 'dark'`.
- 문서 사이 링크(`docs/MANUAL.md`, `MANUAL.md#앵커`)를 사이트 경로로 다시 쓴다. 저장소 밖 파일 링크(src/ 등)는 GitHub blob URL로.
- 헤딩 id는 GitHub와 같은 규칙(소문자, 공백→`-`, 구두점 제거, 한글 유지)으로 만들어 문서 내 목차 앵커가 동작하게 한다.
- 실행: `node site/build.mjs`(→ `_site/`), `node site/serve.mjs`(의존성 없는 node:http 정적 서버, 기본 포트 4173). 루트 `package.json`의 `site:build`·`site:serve` 스크립트는 엔진 작업이 끝난 뒤 추가한다.
- `site/build.mjs`는 `node_modules`가 없으면 `npm ci --prefix site`를 안내하고 종료코드 2로 끝난다.

## 3. Mermaid 안전 규칙

과거 커밋에서 엣지 라벨의 `>`, `≤`, 따옴표 때문에 렌더가 깨졌다. 모든 노드 라벨을 `["…"]`로 감싸고, 엣지 라벨 `|…|`에는 부등호·따옴표·괄호를 쓰지 않는다. 빌드 스크립트에서 엣지 라벨의 위험 문자를 검사해 경고(또는 실패)하게 한다.

## 4. 웹 콘솔

- 데모 모드(기본): 브라우저 안에서 core의 mock 에이전트를 transport로 연결 — 네트워크 없이 취약/방어 비교, 게이트, 리포트 다운로드(Markdown·JSON).
- 실제 연결 모드: `fetch` transport. 대상이 CORS를 허용해야 함을 화면에 명시. 권한 확인 체크 전에는 실행 버튼 비활성. 키는 메모리에만.
- 판정·게이트·리포트 렌더는 전부 core 함수 호출. 웹에서 판정 로직을 다시 짜지 않는다.

## 5. 배포 워크플로

- `.github/workflows/pages.yml`: push to main(+ workflow_dispatch) → `npm ci --prefix site` → `node site/build.mjs` → `actions/upload-pages-artifact` → `actions/deploy-pages`. 권한 `pages: write`, `id-token: write`. concurrency group `pages`.
- Pages 소스는 "GitHub Actions"로 설정한다(`gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow`). 이 활성화는 사용자 승인 후 오케스트레이터가 한다.

## 6. 검증 (완료 조건)

로컬: `node site/build.mjs && node site/serve.mjs` 후 브라우저에서
1. 모든 내비게이션 링크가 200
2. Mermaid가 있는 페이지마다 `pre.mermaid svg`가 생기고 "Syntax error" 텍스트가 없음
3. 웹 콘솔 데모 실행 → 취약 모드 게이트 FAIL, 방어 모드 PASS
4. 콘솔 에러 없음, 모바일 폭(375px)에서 가로 스크롤 없음

배포 후: 같은 항목을 https://namojo.github.io/agent-redteam/ 에서 다시 확인한다.
