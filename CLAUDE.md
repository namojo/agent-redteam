# agent-redteam

## 하네스: agent-redteam 개선

**목표:** 배포 전 AI 에이전트 모의 해킹 도구(agent-redteam)를 분석·재설계·구현·검증해, 판정을 믿을 수 있고 문서가 실제 구현과 일치하는 상태로 유지한다.

**트리거:** agent-redteam의 재구축·기능 개선·판정 수정·문서/사이트 갱신·릴리스 전 점검 요청 시 `redteam-rebuild` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**규칙:** 사용자 보고·질문은 한국어, 코드·식별자·커밋 메시지는 영어. 공개 저장소이므로 push 전 `node .claude/skills/redteam-qa/scripts/hygiene.mjs`를 통과시킨다. `main`에 force-push 금지.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-11-13 | 초기 구성 (architect·engine·web·docs·qa 5개 에이전트, 오케스트레이터 + 4개 스킬, 위생 검사 스크립트) | 전체 | 사내망에서 미완성된 저장소를 처음부터 재검토·재구축 |
| 2026-11-13 | 사이트 빌드 의존성을 `site/package.json`으로 분리, 사이트 인프라를 엔진 구현과 병렬로 시작 | skills/redteam-site, redteam-rebuild, redteam-qa | 루트 package.json 충돌 방지, 대기 시간 단축 |
