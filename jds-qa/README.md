# JDS-QA 대시보드 — 지라 자동 동기화

`https://jelin-cc.github.io/jobplanet-ut/jds-qa/`

## 구성
- `index.html` — 대시보드 (단일 파일). 데이터 블록(`SEED`/`SPRINT_OF`/`QA_OF`/`SUBTASKS`/`ASOF`)은 **자동 생성**되므로 직접 수정 금지.
- `meta.json` — 큐레이션(수기 유지) 데이터. 지라에 없는 `name`/`pf`/`cat`, 스프린트 코드 매핑, QA 명단, 대상 에픽/JQL.
- `scripts/fetch-jira.mjs` — 지라 → 데이터 블록 변환·치환 스크립트.
- `../.github/workflows/sync-jira.yml` — 매일 1회 실행 + Pages 재배포.

## 동작
1. 매일 **08:00 KST** GitHub Actions 실행
2. JQL `parent in (HMS-176, HMS-177)` 로 이슈 조회
3. 지라 라이브 필드(상태·담당자·스프린트·QA·하위작업)를 `meta.json` 큐레이션 라벨과 병합
4. `index.html` 데이터 블록 갱신 → 커밋 → GitHub Pages 재배포

## 최초 1회 설정 (자동 동기화 켜기)
1. **아틀라시안 API 토큰 발급**: https://id.atlassian.com/manage-profile/security/api-tokens → *Create API token*
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에 2개 등록
   - `JIRA_EMAIL` : 아틀라시안 계정 이메일
   - `JIRA_TOKEN` : 위에서 발급한 토큰
3. **Actions** 탭 → *Sync JDS-QA from Jira* → *Run workflow* 로 첫 실행 테스트
4. 이후 매일 자동 실행 (수동 실행도 *Run workflow* 버튼으로 가능)

## 손볼 일이 생기면
- 컴포넌트 이름/플랫폼/카테고리 변경 → `meta.json` 의 `items` 수정
- 새 스프린트 추가 → `meta.json` 의 `sprintCodeByName` 와 `index.html` 의 `SPRINTS`(색/라벨)에 코드 추가
- 에픽에 이슈가 새로 생기면 자동 포함되며, `meta.json` 에 라벨이 없으면 실행 로그에 `⚠ 신규 이슈` 로 표시됨 → `items` 에 추가

## 로컬에서 수동 갱신 (토큰 사용)
```bash
JIRA_HOST=jobplanet.atlassian.net JIRA_EMAIL=you@jobplanet.com JIRA_TOKEN=xxxx \
  node jds-qa/scripts/fetch-jira.mjs
```
