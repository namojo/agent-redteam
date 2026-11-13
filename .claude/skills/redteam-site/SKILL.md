---
name: redteam-site
description: agent-redteam 웹 콘솔(web/)과 GitHub Pages 사이트(site/ 빌드, Markdown→HTML, Mermaid 다이어그램 렌더링, pages.yml 배포) 구현·수정·검증 규칙. 웹 콘솔, Pages, 사이트, 다이어그램 깨짐, 문서 사이트 빌드, namojo.github.io/agent-redteam 관련 작업이면 반드시 사용.
---

# 웹 콘솔과 Pages 사이트

## 1. 산출물 구조

```
web/                 웹 콘솔 (정적 HTML + ES 모듈, 빌드 없음)
  index.html
  console.mjs        src/core/를 상대 경로로 import
site/
  build.mjs          docs/*.md, README → _site/*.html, web/·src/core/ 복사, Mermaid 자산 복사
  template.html      공통 레이아웃(내비게이션: 소개·빠른 시작·매뉴얼·예시 리포트·웹 콘솔·GitHub)
  style.css
_site/               빌드 결과 (gitignore)
.github/workflows/pages.yml
```

사이트 URL 구조: `/` 소개(README 기반), `/manual.html`, `/architecture.html`, `/offline-install.html`, `/example-report.html`, `/console/` 웹 콘솔. 실제 파일명은 build.mjs의 매핑 표 하나에서 관리한다.

## 2. 빌드 원칙

- Markdown 변환은 빌드 시점에 한다(devDependency `marked`, 버전 고정 `--save-exact`). 런타임 dependencies는 계속 0개.
- **Mermaid는 CDN이 아니라 사이트에 자체 호스팅**한다: 빌드가 `node_modules/mermaid/dist/mermaid.min.js`를 `_site/assets/`로 복사. 사내망에서 CDN이 막혀도 다이어그램이 보이고, 버전이 고정된다.
- ```` ```mermaid ```` 코드 블록은 `<pre class="mermaid">`(HTML 이스케이프한 원문)로 바꾸고 `mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' })`. 다크 모드면 `theme: 'dark'`.
- 문서 사이 링크(`docs/MANUAL.md`, `MANUAL.md#앵커`)를 사이트 경로로 다시 쓴다. 저장소 밖 파일 링크(src/ 등)는 GitHub blob URL로.
- 헤딩 id는 GitHub와 같은 규칙(소문자, 공백→`-`, 구두점 제거, 한글 유지)으로 만들어 문서 내 목차 앵커가 동작하게 한다.
- `package.json` scripts: `site:build`, `site:serve`(의존성 없는 node:http 정적 서버).

## 3. Mermaid 안전 규칙

과거 커밋에서 엣지 라벨의 `>`, `≤`, 따옴표 때문에 렌더가 깨졌다. 모든 노드 라벨을 `["…"]`로 감싸고, 엣지 라벨 `|…|`에는 부등호·따옴표·괄호를 쓰지 않는다. 빌드 스크립트에서 엣지 라벨의 위험 문자를 검사해 경고(또는 실패)하게 한다.

## 4. 웹 콘솔

- 데모 모드(기본): 브라우저 안에서 core의 mock 에이전트를 transport로 연결 — 네트워크 없이 취약/방어 비교, 게이트, 리포트 다운로드(Markdown·JSON).
- 실제 연결 모드: `fetch` transport. 대상이 CORS를 허용해야 함을 화면에 명시. 권한 확인 체크 전에는 실행 버튼 비활성. 키는 메모리에만.
- 판정·게이트·리포트 렌더는 전부 core 함수 호출. 웹에서 판정 로직을 다시 짜지 않는다.

## 5. 배포 워크플로

- `.github/workflows/pages.yml`: push to main(+ workflow_dispatch) → `npm ci` → `npm run site:build` → `actions/upload-pages-artifact` → `actions/deploy-pages`. 권한 `pages: write`, `id-token: write`. concurrency group `pages`.
- Pages 소스는 "GitHub Actions"로 설정한다(`gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow`). 이 활성화는 사용자 승인 후 오케스트레이터가 한다.

## 6. 검증 (완료 조건)

로컬: `npm run site:build && npm run site:serve` 후 브라우저에서
1. 모든 내비게이션 링크가 200
2. Mermaid가 있는 페이지마다 `pre.mermaid svg`가 생기고 "Syntax error" 텍스트가 없음
3. 웹 콘솔 데모 실행 → 취약 모드 게이트 FAIL, 방어 모드 PASS
4. 콘솔 에러 없음, 모바일 폭(375px)에서 가로 스크롤 없음

배포 후: 같은 항목을 https://namojo.github.io/agent-redteam/ 에서 다시 확인한다.
