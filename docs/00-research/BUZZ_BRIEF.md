# ohmyslack — 구현 가능성·구현 범위 토론 브리프 (Buzz)

- 작성: Jarvis (2026-11-07) / 요청자: 영환님
- 목적: "현재 쓰는 Slack을 REA로 분석해 ohmyslack으로 구현"하는 안의 **가능성 판정**과 **구현해야 할 범위(MVP)**를 합의한다.
- 산출물: 에이전트별 파일 1개 + 스레드 답글 1건(요약 + 파일 경로). 결정은 영환님이 내린다 — 에이전트 권고는 결정이 아니다.

## 0. 현재 상태 (확인된 사실)

- 프로젝트 폴더 `~/Work/ohmyslack`: 비어 있음, Git 저장소 아님, Jarvis 프로젝트 레지스트리 미등록. **이번 토론에서는 `docs/00-research/` 아래 파일 쓰기만 허용.**
- 분석 대상: macOS Slack 데스크톱 `4.51.180` (`com.tinyspeck.slackmacgap`, 서명 팀 `BQR82RBBHL`). REA `6.5.0`, Node `v24.12.0`.
- Jarvis가 이미 실행한 REA 정적 분석 (읽기 전용):
  1. `inspect_electron_fuses` (ev_d4bb9636…): `RunAsNode`·`EnableNodeOptionsEnvironmentVariable`·`EnableNodeCliInspectArguments` **disabled**, `EnableEmbeddedAsarIntegrityValidation`·`OnlyLoadAppFromAsar`·`EnableCookieEncryption` **enabled** (x64·arm64 동일). → 실행 중인 앱에 Inspector로 붙는 런타임 관찰은 사실상 차단, 앱 수정은 서명·무결성 검증을 깸.
  2. `analyze_javascript_application` on `app-arm64.asar` (parent ev_f49e0e82…, summary ev_70bb0ffb…): 파일 1,228개 / 파싱한 JS 529개 / 파싱 실패 0. 커버리지 `partial`(결과 예산 한도로 `preload.bundle.js` 등 관계 그래프 일부 생략, 미확인 다수).
     - 진입점 `dist/main.bundle.cjs`(~1.9MB), `dist/preload.bundle.js`(~0.9MB).
     - 첫 화면 `https://app.slack.com/ssb/first` 로드 → **실제 채팅 UI는 원격 웹앱**, 데스크톱은 Electron 셸.
     - 창 3종(메인, TSAuth 로그인, 넷로그). webPreferences: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webviewTag:false`.
     - IPC 52건(동적 채널 44), `contextBridge` 노출 `__SENTRY_IPC__` 등, 네이티브 모듈 8종(알림 상태·Focus Assist·keymap·native auth·cf-prefs·file-handler-info 등), 트레이·자동 업데이트, 딥링크 `slack://channel|open|app/|doc`.
     - remote-debugging-port 8315는 Slack 내부 dev 모드에서만 추가됨.
  3. 실제 웹앱 코드 위치: Service Worker 캐시(~493MB, `~/Library/Containers/com.tinyspeck.slackmacgap/.../Service Worker`). REA `recover_javascript_sources`는 Linux x64 전용이라 이 Mac에서는 미사용(확인 필요).
- Jarvis 1차 판단: **클린룸 Slack형 메신저는 가능, Slack 코드 복원·이식형 클론은 비권장**(약관·법적 위험, Slack 서버 API 종속). 약관 원문은 아직 미확인.

## 1. 방향 후보 (각자 1–5점 채점 + 1개 추천)

1. 클린룸 Slack형 메신저(자체 서버). Slack은 동작·UX 참고만, 코드는 새로 작성. (Jarvis 잠정 추천)
2. 기존 Slack 워크스페이스를 쓰는 커스텀 클라이언트(공식 Web API + Socket Mode/Events).
3. REA 분석 보고서만(데스크톱 셸 아키텍처 문서), 구현 없음.
4. (선택) 하이브리드: 1의 자체 서버 + 2의 Slack 브리지(가져오기/동기화).

## 2. Jarvis 잠정 기반환경 (반박·수정 대상)

- FE: React + TypeScript + Vite, TanStack Query, WebSocket, TanStack Virtual, 입력기 Lexical 또는 TipTap.
- BE: Node 24 + Fastify(또는 NestJS) + `ws`.
- 데이터: 공용 인프라 `~/Work/shared-infra` PostgreSQL(새 DB `ohmyslack`), Redis(새 DB 번호: pub/sub·presence·unread), 검색은 Postgres FTS → 필요 시 Meilisearch, 파일은 MinIO(S3 호환, 신규 추가 필요). `docker compose down -v`·볼륨 삭제 금지.
- 데스크톱(2단계): Electron, Slack에서 관찰한 보안 기본값(contextIsolation·sandbox on, nodeIntegration off, fuse 잠금, `ohmyslack://` 딥링크, 트레이·알림).
- MVP 잠정: 워크스페이스·채널·DM·스레드·멘션·unread·실시간·파일 업로드·검색·presence. 제외: Huddle/통화, 앱 마켓, Enterprise Grid.

## 3. 분장 (에이전트당 범위 1개, 파일 1개)

- **A. Claude-Fable — 가능성·위험 판정** → `docs/00-research/buzz/Claude-Fable.md`
  - Slack 이용약관·AUP·데스크톱 라이선스의 리버스 엔지니어링·클론 관련 조항 확인(원문 URL·인용), 클린룸 원칙(무엇을 보고 무엇을 쓰면 안 되는지), 상표·에셋(사운드·폰트·아이콘) 사용 경계.
  - REA로 더 얻을 수 있는 것/없는 것(위 0번 증거 기준)과 추가로 해볼 가치가 있는 정적 분석 1–3개.
- **B. GPT-Sol — 구현 범위(MVP) 정의** → `docs/00-research/buzz/GPT-Sol.md`
  - Slack 기능을 그룹별로 나눠 MVP / v1 / 제외로 분류(각 항목에 이유). 사용자 시나리오 5개 이내와 MVP 수용 기준.
  - 방향 1–4 채점은 범위·일정 관점에서.
- **C. GPT-Luna — 아키텍처·기반환경** → `docs/00-research/buzz/GPT-Luna.md`
  - 2번 잠정 스택 검증·대안(예: 실시간 계층, 메시지 저장/정렬/페이지네이션, unread·스레드 데이터 모델, 검색, 파일), 핵심 테이블 초안, 로컬 개발 환경(shared-infra 재사용 조건), Electron 단계 분리 여부.
- **D. Claude-Opus 5.5 — 교차검토·실행 계획** → `docs/00-research/buzz/Claude-Opus.md`
  - A–C 결과가 올라오면 충돌을 정리하고, 단계별 계획(P0–P4)과 **하지 말 것(do-not-do)** 목록, 영환님 결정 필요 항목을 위험 순으로 정리. 먼저 0–2번만 보고 초안을 쓴 뒤 A–C 반영해 갱신해도 됨.

## 4. 공통 규칙

- 답변 형식: **결론 → 근거(URL·관찰·Evidence ID) → 사실/추정/확인 필요 → 요구사항·결정 후보(번호)**. 방향 1–4 점수표(1–5)와 추천 1개 포함.
- 외부 사이트 조사: 먼저 해당 사이트 `robots.txt`·약관을 확인하고, 금지면 추가 페이지를 가져오지 말고 이미 주어진 자료만 사용. Slack 웹앱 소스 다운로드·복원·디버거 연결·Slack.app 수정 금지. 로그인된 실제 워크스페이스 데이터 조회 금지.
- 쓰기 범위: `~/Work/ohmyslack/docs/00-research/buzz/<본인>.md`만. 다른 경로 수정·Git 작업·설치 금지.
- 스레드: 본인 파일 작성 후 요약 + 경로로 답글 1건. 다른 에이전트와 충돌이 있으면 교차 코멘트 1회만.
- 한국어 존댓말.
