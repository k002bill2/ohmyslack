# ohmyslack — Slack 기능 추가 이전 검토 브리프 (Buzz, 3차)

- 작성: Jarvis (2026-11-10) / 요청자: 영환님 — 「기본 구현은 끝난 것 같은데, Buzz를 통해 Slack 기능을 더 이전할 수 있는지 검토」
- 목적: 지금 Slack에서 쓰는 기능 중 **ohmyslack으로 더 옮길 것·옮기지 않을 것·순서**를 정한다. 결정은 영환님이 내린다 — 에이전트 권고는 결정이 아니다.
- 산출물: 에이전트별 파일 1개(`docs/00-research/buzz-parity/<본인 표시 이름>.md`) + 같은 스레드 답글 1건(요약 + 파일 경로).
- 저장소: `/Users/younghwankang/Work/ohmyslack` (기준 커밋 `main` = `92382b7`, 작업 브랜치 `feat/design-refresh-r4` = `901a34c`). **읽기 전용** — 본인 산출물 파일 1개만 쓴다.

## 0. 확정 결정 (반박 대상 아님)

1. 클린룸 자체 서버 메신저(방향 1). Slack API·실시간 브리지·Slack 코드/에셋/스크린샷/사운드/이모지 이미지 사용 금지 — `CLEANROOM.md` §3.
2. 개인 전용 + Tailscale Serve(tailnet), 서버는 `127.0.0.1` 바인드, Funnel 금지. Redis·브로커·마이크로서비스 도입 금지 — `CLAUDE.md` Hard constraints.
3. 웹 + PWA(iPhone 홈 화면), 앱스토어 출시 없음. 대화 본문·인증 응답의 기기 지속 캐시 금지(B7, FR-CLIENT-04).
4. Slack을 쓰는 핵심 이유는 **Hermes Jarvis와의 대화·브리핑**이다(ADR-001 §1, 2026-11-08 영환님). 이 연동은 이미 P0로 구현됨.
5. PRD §8 명시적 제외: 멀티 워크스페이스·게스트, @channel, 통화·Huddle·영상, 앱 마켓·제3자 봇·워크플로·Canvas, SSO/SCIM·감사, 네이티브 앱. 이 항목을 되살리려면 이유를 따로 적는다(점수 대상 아님).

## 1. 현재 상태 (확인된 사실, Jarvis 2026-11-10)

### 1-1. 구현됨 (PRD v1.3 P0 42개 기준)
- 인증: 초대 링크·이메일+비밀번호·세션·비활성화·로그인 제한 (FR-AUTH-01–03·05·06). 서버에 `GET /api/sessions` 있음(웹 화면은 없음 — FR-AUTH-04 P1).
- 공간: 단일 워크스페이스, 공개 채널 생성·참여·나가기, 1:1 DM (FR-CONV-01–04). 라우트 목록: `apps/server/src/**/routes.ts`.
- 메시지: 전송 상태·멱등 재시도·seq 페이지·수정/삭제·1단 스레드·멤버 멘션·한글 IME·제한 서식(굵게·인라인 코드·목록·제목·링크) (FR-MSG-01–08·10). 렌더러 `apps/web/src/features/conversation/render.ts:6-24`.
- 동기화: WS 실시간·서버 커서 catch-up·채널/스레드 unread 분리·다기기 읽음 (FR-SYNC-01–07).
- 클라이언트: 다중 패널·모바일·PWA·Web Push·접근성 (FR-CLIENT-01–05·07). R4 디자인 갱신(브랜치 `feat/design-refresh-r4`): 메시지 툴바·더보기/우클릭 메뉴(스레드 답글·텍스트 복사·메시지 링크 복사·수정·삭제), 「이동…」 전환기, 분할선 드래그·레일 접기.
- 첨부: mp3·png/jpeg/webp만 (FR-OPS-05). 테이블 `apps/server/migrations/0003_attachments.sql`.
- Hermes 봇: 봇 계정·토큰·Jarvis DM·스레드=세션·텍스트 명령 승인 `/approve`·`/deny` (FR-BOT-01–06). 어댑터 `integrations/hermes-plugin/ohmyslack/adapter.py`(606줄).
- DB 테이블(0001–0004): workspaces, users, workspace_members, invites, sessions, conversations, conversation_members, messages, sync_clock, conversation_changes, conversation_read_state, thread_read_state, thread_unread_targets, message_mentions, bot_tokens, attachments, attachment_blobs, push_subscriptions.

### 1-2. 미구현·후보 (PRD에 이미 있는 것)
- P1: FR-AUTH-04 기기 세션 화면, FR-CONV-05 비공개 채널·그룹 DM·채널 보관, FR-OPS-06 검색(PostgreSQL FTS, 한국어), FR-OPS-07 presence·입력 중, FR-OPS-09 일반 파일 첨부, FR-BOT-07 후보 버튼형 승인.
- P2: FR-MSG-09 이모지 반응·저장·고정·예약 전송, FR-CLIENT-06 Electron, FR-OPS-08 Slack 공식 export 1회 가져오기.
- 제안(미결정): `docs/09-specs/BOT_CHANNEL_SPEC.md`(브랜치 `k002bill2/p1-bot-channel-spec`, `git show k002bill2/p1-bot-channel-spec:docs/09-specs/BOT_CHANNEL_SPEC.md`) — Jarvis 봇을 공개 채널에 추가하고 멘션으로 부르기. §10에 영환님 결정 Q1–Q8.

### 1-3. Hermes 어댑터 공백 (사실, 코드 대조)
Hermes 기본 어댑터(`/Users/younghwankang/.hermes/hermes-agent/gateway/platforms/base.py`, 읽기 전용)가 제공하는 훅 중 ohmyslack 어댑터 상태:
- `send_typing` → no-op (`adapter.py:575-576`), `stop_typing`·`on_processing_start/complete` 미구현.
- `send_document`·`send_video` → 텍스트 안내로 대체 (`adapter.py:564-573`, `_attachment_fallback` 501-507).
- `send_exec_approval`·`send_clarify`·`send_slash_confirm`·`send_private_notice`·`send_draft`(스트리밍)·`delete_message`·`send_multiple_images` 미구현 → 기본 동작(텍스트) 사용.
- `get_chat_info` 고정값 (`adapter.py:578-579`).
- 참고: Hermes Slack 어댑터(`/Users/younghwankang/.hermes/hermes-agent/plugins/platforms/slack/adapter.py`, 6,961줄)는 위 훅 대부분을 구현. **읽기·비교만, 코드 복사 금지.** (Hermes 소스는 Slack 코드가 아니므로 클린룸 대상 아님. 단 Slack Block Kit 같은 Slack 고유 포맷을 ohmyslack 계약으로 들여오지 않는다.)

### 1-4. 진행 중 일정 (충돌 주의)
- Slack→ohmyslack 전환 판정 7일 관찰 창: 2026-11-10–11-16, 판정 가능 11-17 이후 (`qa/manual/QA-HERMES-CUTOVER.md:10,23`). 관찰 창 중 Hermes 어댑터·푸시 경로 변경은 관찰을 무효화할 수 있다.
- G1 게이트 미통과 (`qa/QA_REPORT_P1.md:16`).

## 2. 방향 후보 (각자 1–5점 채점 + 1개 추천)

1. **Jarvis 대화 동등성 우선** — Slack에서 Jarvis와 쓰는 상호작용(버튼 승인·clarify·입력 중/처리 상태·문서 첨부·스트리밍·채널 참여)을 먼저 옮겨 Slack을 끌 수 있게 한다.
2. **일반 메신저 동등성 우선** — 검색·반응·저장/고정·비공개 채널·그룹 DM·presence 등 사람 간 메신저 기능을 먼저.
3. **하이브리드** — 1의 상위 2–3개 + 2의 상위 2–3개를 한 단계로.
4. **동결** — 전환 판정(11-17)·G1 통과 전까지 기능 추가 없음, 그 뒤 재검토.

## 3. 분장 (에이전트당 범위 1개, 파일 1개)

- **A. GPT-Sol — 기능 인벤토리·범위 분류** → `docs/00-research/buzz-parity/GPT-Sol.md`
  - 팀 메신저 일반 기능을 그룹(메시지·공간·검색·알림·상태/프로필·파일·봇 상호작용·관리)별로 나열하고 각각 `이미 있음 / P1 후보 / P2 후보 / 이전 안 함`으로 분류(이유 1줄). 영환님 1인+Jarvis 사용 맥락에서 가치(1–5)·빈도 추정.
  - 상위 10개 백로그(순서 + 수용 기준 초안 1–2줄, 새 FR ID는 `FR-<AREA>-nn` 형식 제안만).
- **B. GPT-Luna — 아키텍처·비용** → `docs/00-research/buzz-parity/GPT-Luna.md`
  - A의 후보 중 상위 8–10개에 대해: 테이블·API·WS 이벤트 영향, 경계 규칙(B1–B10)·본문 지속 캐시 금지·Redis 금지와의 정합, 규모(S/M/L), 선행 의존. 특히 검색(FTS 한국어), 반응(이벤트·sync 경로), presence(Redis 없이), 비공개 채널(assertAccess 영향), 일반 파일(FR-OPS-05 경계 재사용).
- **C. Claude-Fable — 클린룸·보안·UX 경계** → `docs/00-research/buzz-parity/Claude-Fable.md`
  - 후보 기능별 클린룸 위험(이모지 이미지·사운드·아이콘·시그니처 UX 복제 위험과 안전한 대안: 오픈 이모지 세트 출처 등), 위협 모델 영향(버튼형 승인의 위조·재생, 알림 payload 개인정보, 파일 업로드), 디자인 레퍼런스(`docs/05-design-ref/DESIGN_REFERENCE.md`)에 추가가 필요한 상태·문구.
- **D. Claude-Opus 5.5 — Jarvis 동등성·교차검토·단계 계획** → `docs/00-research/buzz-parity/Claude-Opus.md`
  - 1-3절 공백을 실제 사용 흐름(최상위 지시→진행 상태→승인→결과/첨부→브리핑) 기준으로 평가: Slack을 끄기 전에 **반드시** 필요한 것 / 있으면 좋은 것 / 불필요. Hermes `base.py` 훅 계약을 읽기 전용으로 확인하고 ohmyslack 쪽 서버 계약(TRD §5-2) 변경 필요 여부 표시.
  - A–C 결과가 올라오면 충돌을 정리하고 단계 계획(전환 관찰 창 11-10–11-16을 깨지 않는 순서)·**하지 말 것** 목록·영환님 결정 항목(위험 순)을 작성. 먼저 0–2절로 초안, A–C 반영 갱신 가능.

## 4. 공통 규칙

- 답변 형식: **결론 → 근거(file:line·공개 문서 URL) → 사실/추정/확인 필요 → 요구사항·결정 후보(번호)**. 방향 1–4 점수표(1–5)와 추천 1개 포함. 공통 질문 1개: 「전환 관찰 창(11-10–11-16) 동안 착수해도 되는 항목은 무엇인가?」
- 외부 조사: 일반 메신저 개념은 공개 문서·일반 관념만. 상용 메신저 도움말을 볼 경우 먼저 해당 사이트 `robots.txt`·약관을 확인하고, 금지면 더 가져오지 말 것. 스크린샷·에셋 저장 금지, 로그인된 실제 Slack 워크스페이스 조회 금지, Slack.app 분석 금지(`CLEANROOM.md` §3·§6).
- 쓰기 범위: 본인 파일 1개만. 코드 수정·Git·설치·DB 접속·`.env` 열람·서버 실행·`~/.hermes` 수정 금지(읽기만).
- 스레드: 본인 파일 작성 후 요약 + 경로로 답글 1건. 다른 에이전트와 충돌이 있으면 교차 코멘트 1회만.
- 한국어 존댓말. 공급자 한도·오류가 나면 반복 호출 없이 오류를 답글로 보고.
