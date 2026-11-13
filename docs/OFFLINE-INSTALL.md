# 폐쇄망 설치

외부 인터넷이 없는 사내망에 agent-redteam을 반입하는 방법. agent-redteam은 **런타임 의존성이 0개**라서 파일만 옮기면 된다. npm 레지스트리 접근도, `npm install`도 필요 없다.

## 1. 준비물

- **Node.js 20 이상**(`node --version`). 20·22·24를 CI에서 검사한다. 사내 표준 Node 배포본을 쓰면 된다.
- 문서 사이트를 사내에서 다시 빌드할 계획이 없다면 그 밖의 도구는 필요 없다. 사이트 빌드 의존성(`marked`, `mermaid`)은 `site/package.json`에만 있고 **문서 사이트를 만들 때만** 필요하다(7절).

## 2. 반입 파일 만들기 (인터넷이 되는 PC에서)

두 방법 중 하나를 고른다.

### 2.1 npm tarball — 실행에 필요한 파일만

```bash
git clone https://github.com/namojo/agent-redteam
cd agent-redteam
npm pack
```

`agent-redteam-0.2.0.tgz`(약 70kB)가 생긴다. `package.json`의 `files`대로 `src/`, `examples/`, `config.example.json`, `README.md`, `LICENSE`만 들어 있다. **`test/`와 `docs/`는 들어 있지 않다.** 반입 후 단위 테스트(`npm test`)까지 돌리려면 2.2를 쓴다.

### 2.2 저장소 zip — 테스트·문서 포함

```bash
git archive --format=zip --prefix=agent-redteam/ -o agent-redteam.zip HEAD
```

GitHub 웹의 "Download ZIP"으로 받아도 같다. 테스트(`test/`), 문서(`docs/`), 웹 콘솔(`web/`), 사이트 빌드 스크립트(`site/`)가 모두 들어 있다(사이트 빌드 의존성 `site/node_modules`는 들어 있지 않다).

반입 전 사내 절차에 따라 파일 해시를 남겨 두면 좋다(`sha256sum agent-redteam-0.2.0.tgz` 등).

## 3. 사내망에서 설치

### 3.1 tarball

작업 디렉터리(프로젝트)에 로컬 설치한다. 레지스트리에 접속하지 않도록 `--offline`을 준다.

```bash
npm install --offline ./agent-redteam-0.2.0.tgz
npx agent-redteam --version
npx agent-redteam run --mock secure --quiet     # PASS, 종료 0
npx agent-redteam run --mock vulnerable --quiet # FAIL, 종료 1
npm run demo --prefix node_modules/agent-redteam
```

`npx`는 로컬 `node_modules/.bin`의 `agent-redteam`을 실행한다. 직접 부르려면 `node node_modules/agent-redteam/src/cli.mjs …`.

### 3.2 zip

```bash
unzip -q agent-redteam.zip
cd agent-redteam
npm test
node src/cli.mjs run --mock secure --quiet
```

`npm test`는 `node --test`이며 네트워크를 쓰지 않는다(127.0.0.1 로컬 가짜 서버만 띄운다). 이 머신(Windows, Node 24)에서 318개 테스트가 모두 통과했다.

## 4. 사내 CA

사내 게이트웨이가 사설 CA 인증서를 쓰면 처음 요청에서 TLS 오류가 난다.

```
  ✗ fail  chat         TLS: TLS 오류 DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate; …
                       → 사내 CA라면 tls.caFile(--ca-file) 또는 NODE_EXTRA_CA_CERTS를 설정하십시오.
```

방법은 두 가지다. 둘 다 PEM 형식 파일이 필요하다.

| 방법 | 설정 | 동작 |
|---|---|---|
| `network.tls.caFile` / `--ca-file` | 설정 파일: `"network": { "tls": { "caFile": "corp-root-ca.pem" } }`(설정 파일 디렉터리 기준), CLI: `--ca-file corp-root-ca.pem`(현재 디렉터리 기준) | 이 파일을 Node `https`의 `ca` 옵션으로 넘긴다. Node 동작대로 **기본 신뢰 저장소 대신 이 파일의 인증서만 신뢰**하므로, 사내 루트(필요하면 중간 인증서까지)를 모두 넣는다. judge 요청에도 같은 CA가 쓰인다 |
| `NODE_EXTRA_CA_CERTS` | 환경변수: `NODE_EXTRA_CA_CERTS=/path/corp-root-ca.pem` | Node 기본 신뢰 저장소에 **추가**한다. 공개 CA와 사내 CA를 함께 쓸 때 편하다. Node 프로세스 시작 시점에만 읽힌다 |

```bash
node src/cli.mjs probe --config config.json --yes --ca-file corp-root-ca.pem
NODE_EXTRA_CA_CERTS=corp-root-ca.pem node src/cli.mjs probe --config config.json --yes
```

`--insecure`(`network.tls.insecure: true`)는 인증서 검증을 끈다. 경고(`INSECURE_TLS`, stderr 안내)와 함께만 동작하며 마지막 수단이다. 웹 콘솔은 브라우저의 신뢰 저장소를 쓰므로 이 설정들을 적용할 수 없다.

## 5. 프록시

**HTTP 프록시는 지원하지 않는다.** agent-redteam은 `HTTP_PROXY`·`HTTPS_PROXY` 같은 환경변수나 프록시 설정을 읽지 않고 대상에 직접 연결한다. 프록시를 거쳐야만 대상에 닿는 환경이라면 대상에 직접 닿는 호스트(또는 CI 러너)에서 실행한다. 프록시 지원은 로드맵이다.

## 6. 자체 점검 순서

설치나 버전 변경 때마다 아래를 돌리고 종료코드를 확인한다.

| 단계 | 명령 | 기대 |
|---|---|---|
| 1 | `node --version` | v20 이상 |
| 2 | `npm test` (zip 반입 시) | fail 0, 종료 0 |
| 3 | `node src/cli.mjs run --mock secure --quiet` | PASS, 종료 0 |
| 4 | `node src/cli.mjs run --mock vulnerable --quiet` | FAIL, 종료 1 |
| 5 | `npm run demo` | "방어 전 FAIL → 방어 후 PASS", 종료 0 |
| 6 | `node src/cli.mjs probe --config config.json --yes` | 실제 대상 연결 확인. fail 없으면 종료 0 |
| 7 | `node src/cli.mjs run --config config.json --dry-run` | 케이스 수·예상 요청 수 확인(요청 없음) |

tarball로 설치했다면 `node src/cli.mjs` 대신 `npx agent-redteam`을 쓴다. 3–5단계는 네트워크 없이 끝난다. 6단계에서 TLS 오류면 4절, 404면 URL 전체 경로, 401이면 키·헤더를 본다([MANUAL 트러블슈팅](MANUAL.md#15-트러블슈팅)).

## 7. 문서 사이트를 사내에서 빌드하려면 (선택)

CLI 실행과는 무관하다. 사내 위키 대신 이 문서를 HTML로 보고 싶을 때만 필요하다.

1. 인터넷이 되는 PC에서 `npm ci --prefix site`로 `site/node_modules`를 만든다(버전은 `site/package-lock.json`에 고정).
2. 저장소와 `site/node_modules`를 함께 반입한다.
3. 사내망에서 `node site/build.mjs` → `_site/`가 생긴다. `node site/serve.mjs`로 `http://127.0.0.1:4173/`에서 본다. 웹 콘솔은 `/console/`.

`_site/`는 정적 파일만이라 사내 웹 서버에 그대로 올려도 된다(`.mjs`를 `text/javascript`로 서빙해야 웹 콘솔이 동작한다).
