# BOT_CHANNEL_SPEC — Jarvis 봇 채널 참여 (우선순위 P1 FR 후보)

- 상태: **확정** — 2026-11-10 영환님이 §10-1 Q1–Q8을 모두 ★ 추천안으로 결정했다. §9-2 표의 문서 행은 L0 레인(`p1-l0-bot-channel-docs`)이 정본(PRD v1.4·TRD R3.4·ADR-001·DEV_DESIGN R3.4·THREAT_MODEL·런북·COPY_GAPS)에 반영했고, 코드 행(테스트 주석)은 L1 몫이다. 정본과 이 문서가 다르면 정본이 우선한다.
- 작성: Jarvis(p1-bot-channel-spec 레인), 2026-11-10
- 기준 커밋: `92382b7`
- 근거 수준: **사실** = `파일:행`으로 확인, **추정** = 코드·문서에서 유추, **확인 필요** = 근거 못 찾음.
- 표기: 단계는 "단계 P1", 우선순위는 "P1 FR"처럼 쓴다(`docs/04-dev-design/DEV_DESIGN.md:16`).
- 참고 출처: 공개 문서(Hermes mattermost 어댑터 소스, 로컬 설치본) 및 '일반 관념'(팀 메신저에서 봇을 채널에 초대하고 멘션으로 부른다는 일반 개념). 다른 상용 메신저의 코드·문서는 인용하지 않는다(`CLEANROOM.md` §2–3).
- 저위험 세부는 "**Jarvis 결정(★)**"으로 이 문서에서 확정한다. 영환님 결정이 필요한 것은 §10에 모은다.

---

## 1. 배경·현황

### 1-1. 지금 봇이 하는 일 (사실)

| # | 현황 | 근거 |
|---|---|---|
| 1 | 봇은 `users.kind='bot'` 행이고 `password_hash`는 NULL이다. 봇별 owner 컬럼은 없고, owner는 봇이 속한 워크스페이스의 활성 owner를 조회 시점에 찾는다(`ORDER BY user_id LIMIT 1`). | `apps/server/migrations/0002_bots.sql:5-9`, `apps/server/src/modules/bots/repo.ts:190-196` |
| 2 | 워크스페이스 역할은 `owner`·`member` 둘뿐이다. | `apps/server/migrations/0001_initial_schema.sql:29` |
| 3 | 봇 생성 CLI가 같은 트랜잭션에서 owner와의 DM(`kind='dm'`)과 두 멤버 행을 만든다. 이것이 봇이 대화에 들어가는 **유일한** 코드 경로다. | `apps/server/src/modules/bots/service.ts:118-131`, `apps/server/src/modules/bots/repo.ts:58-81` |
| 4 | 봇 리스너 라우트는 `me`·이력·답글·전송·수정·sync·snapshot·read-state·첨부만 등록한다. DM 생성·채널 참여·멤버 목록·DELETE는 등록하지 않는다. | `apps/server/src/modules/bots/routes.ts:130-160` |
| 5 | 사람의 채널 참여·나가기는 **본인만** 한다(`POST /api/conversations/:id/join`, `DELETE …/membership`). 다른 사용자(봇 포함)를 채널에 추가하는 라우트는 없다. | `apps/server/src/modules/conversations/routes.ts:124-133`, `apps/server/src/modules/conversations/repo.ts:49-54` |
| 6 | `assertAccess(userId, conversationId, action)`: 행이 없으면 404, `join`은 `kind='channel'`만 확인, 그 밖(`read`·`write`·`leave`)은 활성 멤버만 확인한다. 역할·워크스페이스는 보지 않는다. | `apps/server/src/modules/conversations/service.ts:8,21,52-61`, `apps/server/src/modules/conversations/repo.ts:37-40` |
| 7 | 대화 종류는 `channel`·`dm` 둘뿐이다. 비공개 채널은 코드에 없다. | `apps/server/migrations/0001_initial_schema.sql:69`, `packages/shared/src/conversations.ts:52` |
| 8 | `conversation_members.joined_seq`는 참여 시점의 `last_seq`이며 **unread·mention·스레드 커서 기준선에만** 쓰인다. 이력·snapshot·sync는 `joined_seq`로 자르지 않는다. | `apps/server/migrations/0001_initial_schema.sql:80-89`, `apps/server/src/modules/conversations/repo.ts:104`, `apps/server/src/modules/messages/repo.ts:299-341`, `apps/server/src/modules/sync/repo.ts:19-23,67-80,98-100` |
| 9 | 멘션은 클라이언트가 보낸 `mention_user_ids`를 서버가 "현재 활성 참여자·활성 사용자·작성자 제외"로 걸러 `message_mentions`에 저장한다. 사용자 kind는 보지 않으므로 채널 멤버인 봇도 멘션 대상이 된다. 메시지 projection에 `mention_user_ids`가 실린다. | `packages/shared/src/messages.ts:28,39,85`, `apps/server/src/modules/messages/repo.ts:35-37,148-154`, `apps/web/src/data/http-source.ts:356` |
| 10 | WS 구독은 클라이언트가 대화별 `conversation.subscribe`로 건다. 서버는 구독 시와 팬아웃마다 `assertAccess(…,'read')`를 다시 본다. | `packages/shared/src/realtime.ts:17-20`, `apps/server/src/modules/realtime/hub.ts:197-202,315-342` |
| 11 | 멤버십 **종료**만 이벤트가 있다(`membershipEnded`) → hub가 구독을 지우고 `error{code:'not_found'}`를 보낸다. 멤버십 **추가** 이벤트는 없다. | `apps/server/src/modules/conversations/events.ts:4-7`, `apps/server/src/modules/conversations/service.ts:79-83`, `apps/server/src/modules/realtime/hub.ts:204-206,264-266` |
| 12 | 사람 `GET /api/me`에는 대화 목록이 없다. 봇 `GET /api/bot/v1/me`는 `{id, owner_user_id, conversation_ids}`이며 `conversation_ids`는 활성 참여만, **대화 종류(kind)는 없다**. | `apps/server/src/modules/auth/routes.ts:18-24`, `apps/server/src/modules/bots/routes.ts:123-128`, `apps/server/src/modules/bots/repo.ts:186-204` |
| 13 | 어댑터는 `/me.conversation_ids`를 `_open()`에서만 읽어 대화마다 `conversation.subscribe`를 보낸다. 실행 중 멤버십 변화 처리, `error not_found` 처리(구독 목록에서 제거)는 없다. | `integrations/hermes-plugin/ohmyslack/adapter.py:206,222-224,272-289` |
| 14 | 어댑터는 모든 수신 메시지를 `chat_type="dm"` 리터럴로 Hermes에 넘긴다. 대화 종류·멤버십·멘션을 보지 않는다. | `integrations/hermes-plugin/ohmyslack/adapter.py:350-385` (특히 `:372-373`) |
| 15 | 어댑터의 유일한 관문은 owner 작성자 판정(`author_id == owner_user_id`, 자기 글·삭제·빈 본문 제외)이다. 본문은 보지 않는다. | `integrations/hermes-plugin/ohmyslack/adapter.py:345-348`, `integrations/hermes-plugin/README.md:41` |
| 16 | 15분 상한 `BACKLOG_LIMIT_SECONDS = 15*60`, 넘으면 실행하지 않고 대화별 안내 1회(`_flush_backlog`). dedupe는 `MessageDeduplicator(max_size=5000, ttl=7일)` + cursor `recent_ids`(최대 500). | `integrations/hermes-plugin/ohmyslack/adapter.py:41,44,149,212,355,365-369,423-435`, `integrations/hermes-plugin/ohmyslack/cursor.py:17` |
| 17 | 세션: `thread_id = m.thread_root_id or m.id`(최상위=새 세션, 답글=같은 세션). 송신은 `_thread_root`로 루트를 찾아 `POST /api/bot/v1/conversations/{id}/messages`. | `integrations/hermes-plugin/ohmyslack/adapter.py:370-371,436-468`, `integrations/hermes-plugin/ohmyslack/client.py:157-170` |
| 18 | 홈 채널 = env `OHMYSLACK_HOME_CHANNEL`(Jarvis DM id). `get_chat_info`는 모든 대화에 `{"type":"dm"}`을 돌려주는 스텁이다. | `integrations/hermes-plugin/ohmyslack/__init__.py:11,36,51`, `integrations/hermes-plugin/README.md:25`, `integrations/hermes-plugin/ohmyslack/adapter.py:578-579` |
| 19 | 웹 멘션 후보 = 대화 참여자(`GET /api/conversations/{id}/members`, kind 필터 없음). 봇이 채널 멤버가 되면 후보에 자동으로 들어가고 봇 배지가 붙는다. | `apps/web/src/features/conversation-membership/useMentionCandidates.ts:6-16`, `apps/server/src/modules/conversations/repo.ts:191-198`, `apps/web/src/features/conversation/Composer.tsx:241-244` |
| 20 | 웹 채널 헤더에는 「채널 나가기」만 있다(채널일 때). 봇 추가·제거 컨트롤·DataSource 메서드는 없다. | `apps/web/src/features/layout/AppShell.tsx:156`, `apps/web/src/data/index.ts:112-113,201-205` |
| 21 | 봇을 채널에 넣는 상황은 테스트에서만 raw SQL로 만든다. | `apps/server/test/bots/bot-scope.int.test.ts:93-96` |

**한 줄 요약(사실):** 서버는 "봇이 채널 멤버라면" 이미 읽기·쓰기·멘션·구독을 사람과 같은 `assertAccess`로 처리할 수 있다. 빠진 것은 ① owner가 봇을 넣고 빼는 경로 ② 멤버십 추가 통지 ③ 어댑터의 채널 구분·멘션 게이팅이다.

### 1-2. 문서 간 불일치 (사실)

| # | 문서 | 내용 | 근거 |
|---|---|---|---|
| D1 | PRD FR-BOT-03 (**P0**) | "봇은 owner와의 Jarvis DM(**과 owner가 지정한 채널**)에만 참여" | `docs/02-prd/PRD.md:158` |
| D2 | ADR-001 §3-c | "봇은 owner와의 Jarvis DM에만 참여(**채널 참여는 P1**, owner가 웹에서 명시적으로 추가할 때만)" | `docs/decisions/ADR-001-hermes-agent-integration.md:71` |
| D3 | TRD §5-2 (5) | "② owner가 웹에서 명시적으로 봇을 추가한 채널(**P1**)에만 참여" — 제목은 "멤버십 상한"이지만 **수치 상한은 없다**(범위 규칙) | `docs/03-trd/TRD.md:201` |
| D4 | TRD §5-2 (6) | "채널 join·멤버 추가 라우트는 없습니다" — 봇 토큰 기준. owner가 봇을 넣는 사람 라우트도 TRD 라우트 표에 없다 | `docs/03-trd/TRD.md:202`, `docs/03-trd/TRD.md:84-101`(특히 `:95`) |
| D5 | THREAT_MODEL TM-BOT-04 | 통제 ①에 "(+owner가 지정한 채널)" | `docs/08-security/THREAT_MODEL.md:213` |
| D6 | DEV_DESIGN 6-2 FR-BOT-03 | 지정 테스트 이름은 "owner DM 밖 대화의 … 거부"뿐(채널 양성 케이스 없음) | `docs/04-dev-design/DEV_DESIGN.md:312` |
| D7 | 테스트 주석·런북 | "owner DM + owner가 추가한 채널", "채널이면 owner가 웹에서 봇 추가" — 구현된 경로 없음 | `apps/server/test/bots/bot-scope.int.test.ts:9`, `docs/runbooks/HERMES_BOT.md:15,107` |
| D8 | 단계/우선순위 표기 | ADR·TRD의 맨 "P1"이 단계 P1(MVP)인지 P1 FR인지 정의 없음. DEV_DESIGN은 둘을 구분하라고 한다 | `docs/04-dev-design/DEV_DESIGN.md:13-16` |
| D9 | DEV_DESIGN 단계표 | 단계 P1 MVP = P0 FR 42개, 단계 P2 v1 = P1 FR 중 영환님이 고른 것. 채널 참여는 어느 목록에도 없다 | `docs/04-dev-design/DEV_DESIGN.md:132-133` |
| D10 | ADR §3-d | "채널 멘션: H1–H3 범위 밖(★). P1에서 owner가 채널에 봇을 추가하면 Mattermost처럼 멘션 게이팅" | `docs/decisions/ADR-001-hermes-agent-integration.md:80` |

**판단(추정):** 구현·테스트·ADR 단계 계획(H1–H4, `docs/decisions/ADR-001-hermes-agent-integration.md:193-201`) 어디에도 채널 참여가 없으므로, PRD:158의 괄호는 ADR의 "P1"을 P0 행에 옮겨 적으면서 생긴 표기 누락으로 본다. 정리안은 §9-1.

---

## 2. 목표 / 비목표

### 2-1. 목표
1. owner가 웹에서 **공개 채널**에 Jarvis 봇을 추가·제거한다.
2. 채널에서 owner가 봇을 **멘션**하면 Jarvis가 그 메시지 스레드에서 답한다(최상위 멘션 = 새 세션, 스레드 답글 = 같은 세션).
3. owner 외 작성자의 메시지는 채널에서도 세션 생성·지시 처리·응답 0.
4. 봇 제거 즉시 봇의 이력·이벤트·쓰기 접근이 끊기고, 어댑터는 재연결 없이 구독을 정리한다.
5. Jarvis DM(홈 채널)의 현재 동작·FR-BOT-01–06 판정은 바뀌지 않는다.

### 2-2. 비목표
1. 봇의 **자율** 채널 참여(봇이 스스로 채널을 찾거나 들어가기).
2. 봇 토큰으로 호출하는 채널 join·leave·멤버 추가 라우트(`docs/03-trd/TRD.md:201-202` 유지).
3. 외부 메신저 데이터 import(클린룸, `CLEANROOM.md` §2-4·§3).
4. 비공개 채널(P1 FR `FR-CONV-05`, `docs/02-prd/PRD.md:73` — 별도 FR).
5. 사람 사용자를 다른 사람이 채널에 추가하는 기능(이 스펙의 추가 경로는 봇 대상만).
6. owner 외 멤버의 봇 호출·봇 간 대화, 버튼형 승인(P1 FR 후보 FR-BOT-07, `docs/02-prd/PRD.md:161`).
7. 봇 여러 개·봇별 owner(현재 owner = 워크스페이스 owner, §1-1 #1).

---

## 3. 사용자 흐름

### 3-1. owner가 채널에 봇 추가
1. owner가 참여 중인 공개 채널을 연다.
2. 채널 헤더의 봇 컨트롤(owner에게만 보임, 「채널 나가기」 옆 — `apps/web/src/features/layout/AppShell.tsx:156` 자리)을 연다.
3. 활성 봇 목록(`GET /api/members`의 `kind='bot'`, `apps/web/src/data/http-source.ts:131-134`)에서 Jarvis를 고른다.
4. 웹이 `POST /api/conversations/{id}/bots`(§4-1)를 부른다. 성공하면 멤버 수가 늘고, 멘션 후보에 봇 배지와 함께 Jarvis가 나타난다(§1-1 #19).
5. 서버가 봇 연결에 멤버십 추가를 통지한다(§4-3) → 어댑터가 그 채널을 구독한다.
6. 문구(버튼·확인 Dialog·오류)는 정본에 없다 → `docs/07-ui-spec/COPY_GAPS.md` 결정 필요 항목으로 올린다(§10 Q8). 이 스펙은 문구를 새로 정하지 않는다(`docs/04-dev-design/DEV_DESIGN.md:396`).

### 3-2. 채널에서 봇 호출(멘션)
1. owner가 작성기에서 `@`로 Jarvis를 골라(서버에 `mention_user_ids`로 전달, `apps/web/src/data/http-source.ts:356`) 최상위 메시지를 보낸다.
2. 서버가 `message.created`를 채널 구독자(봇 포함)에게 보낸다. 메시지의 `mention_user_ids`에 봇 ID가 있다.
3. 어댑터: owner 작성자 ✔ + 봇 멘션 ✔ → `chat_type="channel"`, `thread_id = 메시지 id`로 새 Hermes 세션.
4. Jarvis는 그 메시지의 **스레드 답글**로만 진행·결과를 올린다(채널 최상위에 쓰지 않음, §5-6).

### 3-3. 스레드 응답
1. owner가 그 스레드에 답글을 단다. 답글에도 봇 멘션이 있으면(§10 Q5 ★) 같은 세션(`thread_id = thread_root_id`)으로 이어진다.
2. 승인 요청(FR-BOT-06)도 같은 스레드에서 owner의 멘션 + 텍스트 명령으로 처리한다(§5-3).

### 3-4. 봇 제거 → 구독 해제
1. owner가 채널 헤더 봇 컨트롤에서 제거를 확인한다 → `DELETE /api/conversations/{id}/bots/{bot_user_id}`.
2. 서버가 봇 멤버 행에 `left_at`을 찍고 봇 사용자 ID로 `membershipEnded`를 발행한다 → hub가 봇 WS의 그 구독을 지우고 `error{code:'not_found', conversation_id}`를 보낸다(`apps/server/src/modules/realtime/hub.ts:204-206`).
3. 이후 봇의 REST 이력·답글·전송은 `assertAccess`에서 404, 팬아웃은 `deliverable`에서 0건(`apps/server/src/modules/realtime/hub.ts:197-202`).
4. 어댑터는 `error not_found`를 받으면 그 대화를 구독 목록에서 지우고, 진행 중 세션의 송신 404는 재시도 없이 버린다(`client.py`의 재시도는 429·5xx·연결 오류만, `integrations/hermes-plugin/ohmyslack/client.py:120-140`).

### 3-5. 예외 흐름
| 상황 | 결과 |
|---|---|
| owner 외 멤버가 봇을 멘션 | 서버 저장·전달은 정상. 어댑터는 무시(세션 0·응답 0) |
| owner가 멘션 없이 채널에 글 | 어댑터 무시(DM과 다름) |
| 일반 멤버가 봇 추가·제거 API 호출 | 403, DB 변화 0 |
| owner가 DM에 봇 추가 시도 | 400(채널만), DB 변화 0 |
| 비활성 봇·사람 사용자를 대상으로 지정 | 404, DB 변화 0 |
| owner가 채널을 나감 | **Jarvis 결정(★):** 봇 멤버십은 그대로 둔다. owner 글이 없으므로 봇은 아무것도 하지 않는다. 다시 참여하면 이어서 쓴다 |
| 이미 추가된 봇을 다시 추가 | 200, 상태 변화 0(멱등) |

---

## 4. 서버 변경

### 4-1. 라우트 (메인 리스너, 사람 세션 쿠키)

| 메서드·경로 | access 메타(B2) | 동작 | 응답 |
|---|---|---|---|
| `POST /api/conversations/{id}/bots` 본문 `{ bot_user_id }` | `conversation`(경로 `{id}`) + **새 `AccessAction` `manage_bots`** (§10 Q3 ★) | 대상이 같은 워크스페이스의 활성 `kind='bot'` 사용자인지 확인 → `conversation_members` UPSERT(`joined_seq = last_seq`, 읽음 커서 같은 값 — 사람 `joinIn`과 같은 규칙, `apps/server/src/modules/conversations/repo.ts:137-146`) → 멤버십 추가 이벤트 발행(§4-3) | 201(새로 추가)·200(이미 멤버), 대상 오류 404, DM 400 |
| `DELETE /api/conversations/{id}/bots/{bot_user_id}` | 같음 | 봇 멤버 행 `left_at` 설정 → `membershipEnded(봇 ID, 대화 ID)` 발행 | 204, 멤버가 아니면 204(멱등) |

- CSRF·Origin 검사는 기존 메인 리스너 규칙을 그대로 따른다(새 규칙 없음).
- 봇 리스너(`/api/bot/v1/**`)에는 아무 라우트도 추가하지 않는다(비목표 2).
- 봇 목록 조회는 기존 `GET /api/members`(kind 포함)를 쓴다. 새 목록 라우트 없음.

### 4-2. 권한 판정 — `assertAccess` 단일 경계

`AccessAction`(`apps/server/src/modules/conversations/service.ts:8`)에 `manage_bots`를 더한다. 판정은 `assertAccess` 안에서만 한다(`docs/04-dev-design/DEV_DESIGN.md:90` B2).

판정 순서(앞에서 걸리면 끝 — 비참여자에게 대화 종류를 드러내지 않도록 멤버십을 종류보다 먼저 본다. 기존 `leave`도 멤버 확인 뒤 DM 400, `apps/server/src/modules/conversations/service.ts:79-83`):

| 순서 | 조건 | 실패 시 |
|---|---|---|
| 1 | 대화 행 존재 | 404 |
| 2 | 호출자가 그 대화의 활성 멤버 | 404 (FR-CONV-04 비참여자 404) |
| 3 | 호출자 워크스페이스 역할 = `owner` | 403 (`admin` 메타의 "일반 멤버 403"과 같은 결과, `docs/04-dev-design/DEV_DESIGN.md:116`) |
| 4 | `kind = 'channel'` | 400 (DM `leave` 400과 같은 계열) |

- 현재 `ACCESS_SQL`(`apps/server/src/modules/conversations/repo.ts:37-40`)은 역할을 읽지 않는다 → `manage_bots`일 때만 `workspace_members.role`을 함께 읽는 쿼리 확장이 필요하다(구현 레인 판단, 쿼리 1개).
- 대상 봇 검증(활성·`kind='bot'`·같은 워크스페이스)은 `conversations` 저장소의 봇 추가 트랜잭션 **안에서** 단일 SQL(`BOT_TARGET_SQL`)로 한다 — 검증과 멤버십 UPSERT가 원자적이고, 다른 모듈 repo를 호출하지 않으므로 B1(`docs/04-dev-design/DEV_DESIGN.md:89`)을 지킨다(`apps/server/src/modules/conversations/repo.ts` `addBot`). 영환님 결정(★, 2026-11-10): 초안의 "`bots` 서비스가 검증" 문구를 실제 구현으로 정정.
- 레지스트리 테스트(FR-CONV-04 접근 매트릭스)에 새 라우트 2개와 행위자 {owner, 일반 멤버, 비참여자, 봇 토큰}을 추가한다(`apps/server/test/conversations/access-matrix.int.test.ts`).

### 4-3. 이벤트 — 멤버십 변화 통지

현재 봇은 `/api/bot/v1/me`의 `conversation_ids`를 연결 시에만 읽는다(§1-1 #12·#13). 추가 이벤트가 없으므로 통지 방식을 새로 정한다 — §10 Q4 결정(★ N1)에 따라 `membership.changed`를 쓴다.

**★ N1(채택, §10 Q4) — 새 WS 서버 프레임 `membership.changed`**
- 모양(제안): `{ type: 'membership.changed', conversation_id, state: 'joined' | 'left' }`. `wsServerFrameSchema`(`packages/shared/src/realtime.ts`)에 추가.
- 전달 대상: **영향받는 사용자(봇)의 모든 연결**에만. 대화 구독자 팬아웃이 아니다.
- `ConversationEvents`(`apps/server/src/modules/conversations/events.ts:4-7`)에 `membershipStarted`를 더하고, hub가 `joined`를 보낸다. `left`는 기존 `membershipEnded` 처리(`error not_found` + 구독 삭제) 뒤에 같은 대상에 보낸다.
- 어댑터: `joined` → `/me` 재조회 후 그 대화만 `conversation.subscribe(after_cursor = 현재 watermark)`. `left` 또는 `error not_found` → 구독 목록에서 제거.
- 사람 웹 클라이언트는 이 프레임을 받을 일이 없다(사람은 남이 추가하지 않음). 웹 파서는 `type`이 문자열인 객체를 그대로 넘기고(`apps/web/src/data/realtime.ts:40-51`) 처리기는 `switch`의 알려진 `case`만 다룬다(`apps/web/src/data/http-source.ts:397-421`) → 받아도 무시될 것으로 추정(L1이 단위 테스트로 확인).
- 봇 hub는 사람 hub와 같은 `conversationEvents`를 구독한다(`apps/server/src/modules/bots/ws.ts:74-87`, 특히 `:81`) → 새 이벤트도 같은 배선으로 봇 연결에 닿는다(사실).

대안 N2 — 봇 연결에 기존 `sync.required`를 보내고 어댑터가 그 처리에서 `/me`를 다시 읽는다. 스키마 변경 0이지만 "따라잡기" 신호에 멤버십 의미를 겹쳐 싣는다.
대안 N3 — 멤버십이 바뀌면 봇 WS를 닫아 재연결(`_open()`이 `/me`를 다시 읽음, `integrations/hermes-plugin/ohmyslack/adapter.py:206`). 코드 최소, 재연결 백오프·중복 replay 비용.

### 4-4. 봇 `/me` 확장

어댑터가 DM과 채널을 구분하려면 대화 종류가 필요하다. 메시지 projection에는 대화 종류가 없다(`packages/shared/src/messages.ts:72-90`).
- 제안: `GET /api/bot/v1/me`에 `conversations: [{ id, kind }]`를 **추가**하고 `conversation_ids`는 호환을 위해 유지한다. 멘션 토큰 제거용으로 봇 표시 이름 `display_name`도 싣는다(§5-3).
- 추가(2026-11-12, channel-name-me): `conversations[]`에 `name`(채널=채널 이름, DM=`null`)을 싣는다. 구 서버 호환을 위해 shared 스키마에서 optional. 어댑터는 채널 메시지의 `SessionSource.chat_name`으로 넘겨 Hermes project-router가 `proj-<slug>` 이름으로 프로젝트를 고른다. 이름 변경 이벤트는 구독하지 않는다(`membership.changed` joined 때 `/me` 재조회로 갱신).
- 근거 위치: `apps/server/src/modules/bots/routes.ts:123-128`, `apps/server/src/modules/bots/repo.ts:186-204`, 공유 스키마 `packages/shared/src/bots.ts:7-13`(`botMeSchema` = `{id, owner_user_id, conversation_ids}`).

### 4-5. 봇 읽기 범위 (§10 Q2)

사실: 이력·답글·snapshot·sync·WS replay는 `joined_seq`로 자르지 않는다(§1-1 #8). 봇을 채널에 추가하면 봇 토큰으로 **참여 전 전체 이력**을 읽을 수 있다.
- ★ 채택(§10 Q2) — **봇 행위자에 한해** 가시성 규칙 하나로 판정한다: 메시지 M은 `M.seq > joined_seq` **이고** (M이 최상위이거나 M의 루트 `seq > joined_seq`)일 때만 봇에게 보인다. 즉 **참여 전에 시작된 스레드는 통째로(루트·참여 후 답글 모두) 보이지 않는다.** 사람은 바뀌지 않는다.
- 적용 경로(전부 봇 행위자일 때만): ① 이력 ② 답글 조회 — 루트가 안 보이면 404(현행 `repliesResponseSchema`가 `root`를 필수로 요구하므로 숨김 루트 표현을 새로 만들지 않는다, `packages/shared/src/messages.ts`) ③ snapshot ④ sync ⑤ WS replay ⑥ **WS 실시간 팬아웃** — `message.created`·`message.updated`(답글 생성·삭제 때 루트 projection을 다시 보내는 `emitRoot` 포함, `apps/server/src/modules/messages/service.ts:59-61,78,97`)·`message.deleted` ⑦ 첨부 다운로드(`attachment` 메타 → 첨부의 메시지에 같은 규칙).
- 근거(사실): 팬아웃의 `deliverable`은 세션과 `canRead`(멤버십)만 본다(`apps/server/src/modules/realtime/hub.ts:197-202`). 위 ⑥을 빼면 참여 후 답글 하나로 참여 전 루트 본문이 실시간으로 나간다(Codex 리뷰 P2).
- 결과: owner가 참여 전 스레드에서 봇을 멘션해도 봇은 받지 못한다 → 새 최상위 메시지로 불러야 한다(§3-3에 안내 필요, 문구는 Q8).
- ★ 쓰기 차단(영환님 결정, 2026-11-10): 봇이 `thread_root_id`로 답글을 쓸 때 루트가 위 규칙으로 봇에게 보이지 않으면(참여 전 시작 스레드) **404**, 저장 0. 봇 경로에서는 숨김 루트·없는 루트·봇이 볼 수 없는 다른 대화 루트가 모두 같은 404다(존재 은폐 — 이전 봇 경로의 없는·다른 대화 루트는 400 `invalid_thread_root`). 봇에게 보이는 루트의 형식 위반(답글의 답글·보이는 다른 대화 루트)은 그대로 400. 판정은 같은 `visibleMessageIds`를 재사용한다(`apps/server/src/modules/bots/routes.ts` `threadRootGuard`). 사람은 바뀌지 않는다.
- 재추가 시 `UPSERT_MEMBER_SQL`이 `joined_seq`를 덮어쓴다(`apps/server/src/modules/conversations/repo.ts:49-54`) → 제거 기간의 글도 보이지 않는다.
- 같은 가시성 판정(2026-11-10 보안 리뷰 F-1·F-5): 봇의 read-state(`thread_root_id`가 있을 때 그 루트)와 메시지 수정(`PATCH messages/:id`, 답글이면 그 루트 기준)도 같은 `visibleMessageIds`로 판정하고, 안 보이면 숨김·없음·비참여 모두 같은 `404 not_found`·저장 0이다(`apps/server/src/modules/bots/routes.ts` `assertMessageVisible`). 봇 snapshot·이력 페이지는 `joined_seq`에서 잘라 숨김 구간에서 빈 페이지·seq를 내지 않는다(F-2·F-4).

### 4-6. DB 변경

**스키마 변경 없음(사실 근거).**
- 봇 멤버십은 기존 `conversation_members`(`conversation_id, user_id, joined_at, joined_seq, left_at`) 행으로 표현된다(`apps/server/migrations/0001_initial_schema.sql:80-89`).
- 멘션은 기존 `message_mentions`(`apps/server/migrations/0001_initial_schema.sql:187-195`), 봇 구분은 기존 `users.kind`(`apps/server/migrations/0002_bots.sql:5-9`).
- 역할은 기존 `workspace_members.role`(`apps/server/migrations/0001_initial_schema.sql:25-29`).
- 수치 멤버십 상한은 두지 않는다(§10 Q6 결정). 상수 추가도 없다.

### 4-7. sync·change log
- 봇 멤버십 추가·제거는 `conversation_changes`를 쓰지 않는다(봇 owner DM 생성과 같음, `apps/server/src/modules/bots/repo.ts:54-57` 주석). 사람 기기의 sync 계약은 바뀌지 않는다(추정 — 구현 레인이 `verify-formal-sync` 대상 파일을 건드리면 그 스킬로 재검사).
- 채널 멤버 수 표시(`apps/web/src/features/layout/AppShell.tsx:153`)는 다른 사람 기기에서 다음 목록 갱신 때 반영된다. 실시간 반영은 이 스펙 범위 밖(Jarvis 결정(★): 기존 사람 join과 같은 수준 유지).

---

## 5. 어댑터 변경 (`integrations/hermes-plugin/ohmyslack/`)

### 5-1. `chat_type` dm/channel 구분
- `/me.conversations[].kind`(§4-4)로 `{conversation_id: kind}` 맵을 만든다. `_ingest`의 `build_source(chat_type=…)`(`integrations/hermes-plugin/ohmyslack/adapter.py:372-373`)를 `"dm"` 리터럴 대신 맵 값으로 넣는다(`channel` → `"channel"`).
- 맵에 없는 대화의 메시지는 **무시**한다(현재는 대화 확인 없이 받음, `integrations/hermes-plugin/ohmyslack/adapter.py:350-354`). Jarvis 결정(★): 모르는 대화는 기본 거부.
- `get_chat_info`(`integrations/hermes-plugin/ohmyslack/adapter.py:578-579`)는 맵의 실제 종류를 돌려준다.

### 5-2. 멘션 게이팅 규칙
판정 순서(앞에서 걸리면 끝):
1. owner 작성자 판정 — 기존 `_is_owner_instruction` 그대로(`integrations/hermes-plugin/ohmyslack/adapter.py:345-348`). **채널에서도 가장 먼저.**
2. 대화 종류가 `dm` → 게이팅 없이 통과(현재 동작 유지. 참고 패턴: Hermes mattermost DM 우회, `~/.hermes/hermes-agent/plugins/platforms/mattermost/adapter.py:573-578`).
3. 대화 종류가 `channel` → **`message.mention_user_ids`에 봇 자신의 ID가 있을 때만** 통과.
   - 멘션 판정은 **서버 값만** 쓴다. 본문 `@이름` 문자열은 판정에 쓰지 않는다(Jarvis 결정(★), 근거: "어댑터의 owner 판정은 … 본문 내용으로 판정하지 않습니다" `docs/03-trd/TRD.md:204`와 같은 원칙. 서버 값은 활성 참여자만 남긴 결과 `apps/server/src/modules/messages/repo.ts:35-37`).
   - 참고 패턴과의 차이: mattermost는 본문에서 `@봇이름`·`@봇ID` 부분 문자열을 찾는다(`~/.hermes/hermes-agent/plugins/platforms/mattermost/adapter.py:518-519`). ohmyslack은 서버가 멘션 ID를 주므로 문자열 검색이 필요 없다.
   - allowlist·free-response 채널 설정(mattermost `:510-517`)은 두지 않는다. 채널 범위는 서버 멤버십이 정한다(Jarvis 결정(★)).
4. 수정(`edited_at`)으로 나중에 붙은 멘션은 실행하지 않는다 — 기존 "수정은 실행 안 함" 규칙 유지(`integrations/hermes-plugin/ohmyslack/adapter.py:361-364`).

### 5-3. 멘션 토큰 제거
- 웹 본문에는 `@<표시 이름>` 토큰이 들어간다(`apps/web/src/features/conversation/render.ts:433`). Hermes에 넘기기 전 **본문 맨 앞의** `@<봇 표시 이름>` 토큰 1개만 제거하고 앞뒤 공백을 다듬는다(참고: mattermost는 모든 일치 제거 `:523-526`). 표시 이름은 `/me.display_name`(§4-4).
- 이유: 승인 명령(`/approve`…)은 본문이 `/`로 시작해야 해석될 가능성이 높다(Hermes 승인 파서 조건은 **확인 필요**). Jarvis 결정(★): 맨 앞 토큰만 제거.

### 5-4. 세션 키
- 최상위 채널 메시지: `thread_id = message.id` → 새 세션. 스레드 답글: `thread_id = thread_root_id` → 같은 세션. 현재 규칙(`integrations/hermes-plugin/ohmyslack/adapter.py:370`) 그대로.
- Hermes 세션 키: `<ns>:ohmyslack:channel:<conversation_id>:<thread_id>`. 비DM에서 `thread_id`가 있고 `thread_sessions_per_user`가 기본값(False)이면 사용자 ID를 키에 넣지 않는다(`~/.hermes/hermes-agent/gateway/session.py:691-735`, 특히 `:712-723`). 런타임 설정값은 **확인 필요**(owner만 통과하므로 결과는 같다 — 추정).
- DM 세션 키(`…:dm:<conv>:<thread>`)는 바뀌지 않는다 → 기존 Jarvis DM 세션 연속성 유지.

### 5-5. 홈 채널
- 홈 채널은 **DM 유지**: `OHMYSLACK_HOME_CHANNEL` = Jarvis DM id(`integrations/hermes-plugin/README.md:25`). cron 브리핑·독립 송신은 계속 DM 최상위.
- 채널은 홈 채널이 될 수 없다(Jarvis 결정(★)).

### 5-6. 송신 규칙
- 채널에서는 **스레드 답글로만** 쓴다. `_thread_root`(`integrations/hermes-plugin/ohmyslack/adapter.py:436-442`)가 루트를 못 찾은 채널 송신은 보내지 않고 로그만 남긴다(Jarvis 결정(★)). DM 송신 규칙은 그대로.
- fail-closed(2026-11-10 보안 리뷰 F-3): `/me`로 종류를 확인한 dm만 루트 없이 보낸다. 맵에 없는 대화(추가 직후 재조회 전·재조회 실패·이미 나감)는 루트가 있어도 송신·첨부를 거부하고 고정 문구 로그만 남긴다. `get_chat_info`는 모르는 대화를 `type: "unknown"`(이름은 chat_id)으로 보고한다(`adapter.py` `_refuse_channel_top_level`·`get_chat_info`).

### 5-7. 15분 stale·dedupe 유지 + 게이팅 순서
- 순서: owner 판정 → 대화 종류·멘션 게이팅 → dedupe → 15분 상한. 게이팅에서 걸린 메시지는 dedupe에 기록만 하고(`_remember`) 백로그 개수에 넣지 않는다.
- `BACKLOG_LIMIT_SECONDS`·`MessageDeduplicator`·`RECENT_IDS_MAX` 값은 그대로(§1-1 #16). 새 수치 없음.
- 백로그 안내(`_flush_backlog`, `integrations/hermes-plugin/ohmyslack/adapter.py:423-435`)는 대화 최상위에 글을 쓴다 → **채널에는 쓰지 않고** 홈 채널(DM)에 대화 구분과 함께 1회 보낸다(Jarvis 결정(★), 안내 문구 자체는 기존 `BACKLOG_NOTICE` `:44` 재사용, 대화 구분 표기는 구현 레인이 기존 문구 뒤에 대화 ID만 붙임 — 새 문구 필요 시 §10 Q8).

### 5-8. 멤버십 변화 처리
- §4-3 N1(채택): `_consume`(`integrations/hermes-plugin/ohmyslack/adapter.py:272-289`)에 `membership.changed` 처리를 더한다. `joined` → `/me` 재조회·맵 갱신·그 대화 구독. `left` → 맵·구독 목록에서 제거.
- `error{code:'not_found', conversation_id}`도 같은 제거 처리(현재는 처리 없음).
- `sync.required` 뒤 재구독은 캐시된 목록을 쓰므로(`integrations/hermes-plugin/ohmyslack/adapter.py:281-287`) 그 전에 `/me`를 다시 읽는다(Jarvis 결정(★), 경쟁 조건으로 남은 구독 방지).

### 5-9. 테스트 (pytest, `integrations/hermes-plugin/tests/`)
가짜 서버 fixture(`integrations/hermes-plugin/tests/conftest.py`)에 채널 대화·`kind`·`mention_user_ids`·`membership.changed`를 더한다. 새 파일 `integrations/hermes-plugin/tests/test_channel.py`(제안) 케이스:
1. 채널 owner 멘션 최상위 → `chat_type="channel"`·새 세션 / 답글 → 같은 세션
2. 채널 owner 비멘션 → 무시·백로그 0
3. 채널 비owner 멘션 → 무시(세션 0·송신 0)
4. 채널 owner `@Jarvis /approve` 답글 → 토큰 제거 후 승인 해석
5. `membership.changed joined` → 재연결 없이 구독 / `left`·`error not_found` → 구독 제거, 이후 그 대화 프레임 무시
6. 채널 루트 없는 송신 → 보내지 않음
7. 15분 넘은 채널 멘션 → 실행 0, 안내는 DM으로 1회
8. DM 회귀: 기존 `test_inbound.py`·`test_outbound.py` 전부 통과

---

## 6. 보안 규칙

| # | 규칙 | 통제 위치 | 근거·관련 위협 |
|---|---|---|---|
| S1 | owner 외 작성자 메시지는 **채널에서도** 세션 생성·지시 처리·응답 0. 봇을 멘션해도 같다 | 어댑터 `_is_owner_instruction`이 게이팅보다 먼저(§5-2) | `docs/decisions/ADR-001-hermes-agent-integration.md:73`, TM-BOT-04 `docs/08-security/THREAT_MODEL.md:213` |
| S2 | 승인 명령은 owner·같은 스레드만. 채널에서도 FR-BOT-06 규칙 그대로 | 어댑터 | TM-BOT-06 `docs/08-security/THREAT_MODEL.md:215` |
| S3 | 봇은 owner가 명시적으로 추가한 공개 채널에만 들어간다. 봇 토큰으로 참여·추가 경로 0 | 서버 `manage_bots`(owner 역할) + 봇 리스너 라우트 미등록 | `docs/03-trd/TRD.md:201-202`, `apps/server/src/modules/bots/routes.ts:130-133` |
| S4 | 봇이 읽는 범위: ★ 참여 시점 `joined_seq` **이후** 메시지, 참여 전 시작된 스레드는 통째로 제외(§4-5, §10 Q2). REST·snapshot·sync·WS replay·**WS 실시간 팬아웃(루트 재전송 포함)**·첨부 모두 적용. 구현 전 현재 상태는 "참여 전 전체 이력 읽기 가능"(사실, §1-1 #8) | 서버 봇 읽기·전달 경로 7곳(§4-5) | 최소 권한. 토큰 탈취(TM-BOT-01, `docs/08-security/THREAT_MODEL.md:210`) 시 노출 범위 축소 |
| S5 | 제거 후 접근 즉시 차단: REST는 매 요청 `assertAccess`(404), WS는 `membershipEnded` → 구독 삭제 + 팬아웃마다 `canRead` 재확인 | 서버(기존 경로 재사용) | `apps/server/src/modules/conversations/service.ts:52-61`, `apps/server/src/modules/realtime/hub.ts:197-206` |
| S6 | 수치 판정 "5초 안에 구독 중단"은 FR-CONV-02와 같은 기준을 쓴다(새 수치 없음) | 서버 테스트 | `docs/02-prd/PRD.md:70` |
| S7 | `author_kind`·`author_id`·`mention_user_ids`는 서버 결정값. 어댑터는 본문으로 작성자·멘션을 판정하지 않는다 | 서버 projection·어댑터 | `docs/03-trd/TRD.md:204`, `apps/server/src/modules/messages/repo.ts:35-37` |
| S8 | 봇이 모르는 대화(맵에 없음)의 메시지는 무시 | 어댑터 | §5-1 |

**간접 인젝션 잔여 위험(수용 — 사실/추정 구분):**
- (사실) TM-BOT-05는 "owner가 붙여넣은 외부 텍스트·링크·이미지 안의 지시"를 [수용]하고 승인 게이트를 마지막 방어선으로 둔다(`docs/08-security/THREAT_MODEL.md:214`).
- (추정) 채널에서는 위험 면이 넓어진다: owner가 다른 멤버의 글을 인용·전달하며 Jarvis를 부르면, 다른 멤버가 쓴 지시가 owner 글 **본문**으로 들어온다. 작성자 판정(S1)은 이를 막지 못한다. 통제는 TM-BOT-05와 같다(승인 게이트). §9-4에서 TM-BOT-05 위협 문장에 "채널에서 owner가 인용한 다른 멤버 글"을 더하자고 제안한다.
- (추정) Hermes 도구가 ohmyslack 채널 이력을 스스로 읽는 경로는 현재 없다(어댑터 공개 메서드에 이력 조회 없음 — 확인 필요). 생기면 S4가 노출 범위를 제한한다.

---

## 7. FR·테스트 매핑

### 7-1. 체커 제약 (사실, `tools/check-fr-coverage.ts`)
- PRD FR 표는 5칸 행·첫 칸 `^FR-[A-Z]+-\d+$`이고 **`P0`만** 수집한다(`tools/check-fr-coverage.ts:14,67-79`).
- DEV_DESIGN `### 6-2.` 첫 표의 머리는 `FR | 지정 테스트 이름 | 계층·파일 | 실행 | 필수 보조 증거 | 수동`과 정확히 같아야 하고, 행은 6칸·이름 칸 첫 백틱이 지정 테스트 제목이다(`tools/check-fr-coverage.ts:8,81-91,94-111`).
- PRD P0 집합과 6-2 FR 집합은 양방향으로 같아야 한다(`tools/check-fr-coverage.ts:277-283`). → **P1 FR 행을 6-2에 넣으면 "6-2에만 있음"으로 실패한다.** 아래 7-3 표는 6-2 밖(이 스펙, 반영 후 DEV_DESIGN 6-6 절)에 둔다.
- 지정 테스트는 `apps/server/test`·`apps/web/test`·`e2e`·`perf`·`tools/test`에서만 찾고 제목이 **완전 일치**해야 한다(`tools/check-fr-coverage.ts:12,190-205,248,274`). `integrations/hermes-plugin/tests/*.py`는 지정 테스트가 될 수 없다 → 어댑터 동작은 "수동" 열 `QA-FR-BOT-xx`(필드 `실행자·일시·기기·접속 경로·절차·기대 결과·실제 결과·판정·증거`, 판정 `PASS`, `tools/check-fr-coverage.ts:13,328-336`)로 판정한다. 기존 선례: `docs/04-dev-design/DEV_DESIGN.md:81,222,313,315`.
- 같은 이름 2곳·skip/todo/only는 실패(`tools/check-fr-coverage.ts:16,285-308`).

### 7-2. FR 제안 (PRD §7-8 표 형식, 5열)
ID 규칙은 `FR-{AREA}-{NN}`(`docs/02-prd/PRD.md:154-161`). **FR-BOT-07은 버튼형 승인 후보로 예약**(`docs/02-prd/PRD.md:161`, `docs/decisions/ADR-001-hermes-agent-integration.md:132`) → 새 번호는 08부터.

| ID | 요구사항 | 우선순위 | 수용 기준 | 출처 |
|---|---|---|---|---|
| FR-BOT-03 (개정) | 봇은 owner와의 Jarvis DM에만 참여하고, 서버 이벤트는 작성자 종류를 서버 값으로 싣는다 (채널 참여는 FR-BOT-08–11) | P0 | (현행 유지) | U, ADR-001 §3-c |
| FR-BOT-08 | owner가 웹에서 참여 중인 공개 채널에 봇을 추가·제거한다 | P1 | owner만 성공(일반 멤버 403·DB 변화 0); 비참여 채널 404; DM 대상 400; 비활성·사람·다른 워크스페이스 사용자 대상 404; 재추가 멱등; 봇 토큰으로 추가·제거 경로 0; 제거 후 봇의 이력·쓰기 404, 기존 구독 5초 안에 중단(FR-CONV-02와 같은 기준) | U, ADR-001 §3-c, 이 스펙 §4-1·§4-2 |
| FR-BOT-09 | 채널에 추가된 봇은 참여 이후의 메시지만 읽고, 멤버십 변화를 연결 중에 통지받는다 | P1 | 봇의 이력·답글·snapshot·sync·WS replay·WS 실시간(`message.created`·`updated`·`deleted`, 루트 재전송 포함)·첨부에 참여 전 메시지와 참여 전 시작 스레드의 메시지 0, 참여 전 루트의 답글 조회 404(§10 Q2 ★); 사람 읽기 범위 변화 0; 추가·제거 때 봇 연결에 `membership.changed` 1회(§10 Q4 ★); `/api/bot/v1/me`에 대화 종류 포함 | 이 스펙 §4-3–4-5 |
| FR-BOT-10 | 채널에서 봇은 owner가 멘션한 메시지에만 반응하고, 스레드=세션 규칙을 따른다 | P1 | owner 멘션 메시지의 `mention_user_ids`에 봇 ID 포함(서버); 어댑터: 비owner 0·비멘션 0·`chat_type=channel`·최상위=새 세션·답글=같은 세션·채널 최상위 송신 0·채널 백로그 안내는 DM으로 → 어댑터 pytest + 수동 증거 `QA-FR-BOT-10` | ADR-001 §3-c·§3-d, 이 스펙 §5 |
| FR-BOT-11 | 채널 헤더에서 owner가 봇을 추가·제거하는 웹 컨트롤 | P1 | owner·채널일 때만 보임(일반 멤버·DM·나간 채널 0); 추가 후 멘션 후보에 봇 배지와 함께 표시; 실패는 기존 오류 표시(`ErrorState`) 재사용; 문구는 COPY_GAPS 결정 후 | 이 스펙 §3-1·§3-4 |

### 7-3. 테스트 매핑 (6-2와 같은 6열 머리 — DEV_DESIGN 새 절 "6-6. P1 선택 FR 매핑"으로 옮김, §10 Q7. 기존 6-4·6-5 절 번호를 다른 문서가 참조하므로 6-6으로 둠)

| FR | 지정 테스트 이름 | 계층·파일 | 실행 | 필수 보조 증거 | 수동 |
|---|---|---|---|---|---|
| FR-BOT-08 | `FR-BOT-08 owner만 참여 중인 공개 채널에 활성 봇을 추가·제거하고 일반 멤버·비참여자·DM·사람 대상 요청은 거부되며 제거 후 봇 이력·쓰기는 404이고 기존 구독은 끊긴다` | 통합 `apps/server/test/bots/bot-channel-membership.int.test.ts` | PR | 통합 `apps/server/test/conversations/access-matrix.int.test.ts`: 새 라우트 2개 × {owner, 일반 멤버, 비참여자, 봇 토큰} | — |
| FR-BOT-09 | `FR-BOT-09 채널에 추가된 봇은 참여 이후 메시지만 이력·답글·snapshot·sync·WS replay·WS 실시간·첨부로 받고 참여 전 루트에 달린 새 답글과 루트 재전송도 받지 않으며 추가·제거 때 봇 연결에 멤버십 변화 프레임이 한 번 온다` | 통합 `apps/server/test/bots/bot-channel-scope.int.test.ts` | PR | 단위 `apps/server/test/bots/bots.unit.test.ts`: `/me` 대화 종류 projection | — |
| FR-BOT-10 | `FR-BOT-10 채널에서 owner가 봇을 멘션하면 봇이 받는 message.created의 mention_user_ids에 봇 ID가 있고 멘션 없는 글과 비참여 봇에는 없다` | 통합 `apps/server/test/bots/bot-channel-mention.int.test.ts` | PR | — | `QA-FR-BOT-10`(어댑터 pytest `integrations/hermes-plugin/tests/test_channel.py` §5-9 케이스 1–8 결과 첨부 + 실기 채널 멘션 왕복 1회) |
| FR-BOT-11 | `FR-BOT-11 채널 헤더 봇 컨트롤은 owner에게만 보이고 봇을 추가하면 멘션 후보에 봇 배지와 함께 나타난다` | 컴포넌트 `apps/web/test/conv-bots/bot-channel-control.test.tsx` | PR | — | — |

- FR-BOT-03 지정 테스트(`docs/04-dev-design/DEV_DESIGN.md:312`, `apps/server/test/bots/bot-scope.int.test.ts:88`)는 **바꾸지 않는다**. 다만 `bot-scope.int.test.ts:93-96`의 raw SQL 채널 참여 픽스처는 FR-BOT-08 라우트가 생기면 그대로 둬도 판정에 영향 없음(추정).
- 테스트 종류 요약: 서버 통합 3(08·09·10) + 단위 보조 1 + 접근 매트릭스 보조 1, 웹 컴포넌트 1(11), 어댑터 pytest 1파일(수동 증거로 연결), 수동 QA 1(`QA-FR-BOT-10`).
- 이 이름들은 제안이며 구현 레인이 같은 뜻으로 다듬을 수 있다. 다듬으면 DEV_DESIGN 표와 테스트 제목을 같은 PR에서 맞춘다(`docs/04-dev-design/DEV_DESIGN.md:270`).

---

## 8. 구현 레인 분할안

**의존 순서(안전 제약):** L0 정본 개정 → L1 서버 → L2 어댑터(**배포까지**) → L3 웹 → L4 QA.
- 이유(사실 기반 추정): 현재 어댑터는 모든 메시지를 `chat_type="dm"`으로 넘기고 멘션을 보지 않는다(`integrations/hermes-plugin/ohmyslack/adapter.py:372-373`). 어댑터가 바뀌기 전에 봇이 채널 멤버가 되면, 다음 재연결 때 그 채널을 구독하고(`:206,222-224`) **owner의 모든 채널 글을 지시로 실행**한다. 그래서 웹 컨트롤(L3)은 새 어댑터가 배포된 뒤에 머지한다. L1만 머지된 상태에서는 웹 UI가 없으므로 owner가 직접 API를 부르지 않는 한 봇이 채널에 들어가지 않는다.
- L2는 L1의 계약(§4-3 프레임, §4-4 `/me` 모양)이 확정되면 가짜 서버로 L1과 **병렬 착수 가능**. 머지·배포는 L1 뒤.

| 레인 | 목적 | 쓰기 경로 | 선행 조건 | 규모 | max-turns 제안 |
|---|---|---|---|---|---|
| L0 문서 | §9 개정안 반영(PRD·TRD·ADR·DEV_DESIGN·THREAT_MODEL·런북), FR-BOT-08–11 행, DEV_DESIGN 6-6 절(제안 당시 6-4) | `docs/02-prd/PRD.md`, `docs/03-trd/TRD.md`, `docs/decisions/ADR-001-hermes-agent-integration.md`, `docs/04-dev-design/DEV_DESIGN.md`, `docs/08-security/THREAT_MODEL.md`, `docs/runbooks/HERMES_BOT.md`, `docs/07-ui-spec/COPY_GAPS.md` | §10 Q1–Q8 영환님 결정 | S | 30 |
| L1 서버 | `manage_bots` 판정, 봇 추가·제거 라우트, `membershipStarted` 이벤트·`membership.changed` 프레임, 봇 `/me` 확장, 봇 읽기 `joined_seq` 제한, 테스트(FR-BOT-08·09·10 + 접근 매트릭스) | `apps/server/src/modules/{conversations,bots,realtime,messages,sync}/**`, `packages/shared/src/{realtime,bots}.ts`, `apps/server/test/{bots,conversations}/**` | L0 머지 | L | 120 |
| L2 어댑터 | 대화 종류 맵·`chat_type`, 멘션 게이팅·토큰 제거, 멤버십 프레임·`not_found` 처리, 채널 송신·백로그 규칙, pytest `test_channel.py` | `integrations/hermes-plugin/**` | L1 계약 확정(착수), L1 머지(머지). 배포·게이트웨이 재시작은 영환님(`docs/04-dev-design/DEV_DESIGN.md:81`) | M | 80 |
| L3 웹 | DataSource `addBotToChannel`·`removeBotFromChannel`, 채널 헤더 봇 컨트롤·확인 Dialog, 컴포넌트 테스트(FR-BOT-11) | `apps/web/src/data/{index,http-source}.ts`, `apps/web/src/features/conversation-membership/**`, `apps/web/src/features/layout/AppShell.tsx`, `apps/web/src/ui/copy.ts`, `apps/web/test/conv-bots/**` | L1 머지 + **L2 배포 확인** + COPY_GAPS 문구 결정 | M | 60 |
| L4 QA | `QA-FR-BOT-10` 수동 증거(pytest 결과 + 실기 채널 왕복), 봇 제거 후 차단 실기 확인, DM 회귀(`QA-FR-BOT-04`·`QA-FR-BOT-06` 재실행) | `qa/manual/QA-FR-BOT-10.md`, `qa/manual/QA-FR-BOT-04.md`·`QA-FR-BOT-06.md`(재실행 기록 추가) | L1–L3 머지 + 어댑터 배포 | S | 40 |

- 규모는 추정이다(근거: L1은 모듈 5곳·공유 스키마·쿼리 다수, L2는 파일 1–2개 + 테스트 1파일, L3는 기존 `LeaveChannelControl` 패턴 재사용).
- `apps/server/src/modules/sync/**`·`messages/repo.ts`를 건드리는 L1은 `verify-formal-sync` 스킬 대상이다(스킬 설명 기준). 사람 sync 경로를 바꾸지 않으면 재검사 결과가 같아야 한다.

---

## 9. 원문 개정 제안표 (★ A 확정 2026-11-10 — L0 반영 완료, 코드 행 제외)

### 9-1. PRD FR-BOT-03 우선순위 정리

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **★ A** | FR-BOT-03을 **DM 전용 P0**로 정리(괄호 삭제), 채널 참여는 새 **P1 FR** FR-BOT-08–11, 단계 P2 v1 후보 | 구현·테스트·ADR H1–H4와 일치(§1-2 D2·D6·D9), G1 범위 변화 0, 6-2 행 변경 0 | P0 FR 문구 변경이므로 PRD 변경 이력 기록 필요(`docs/04-dev-design/DEV_DESIGN.md:131` G0 ②) |
| B | 채널 참여를 P0로 올려 G1에 포함(FR-BOT-08–11 P0, 42 → 46) | 단계 P1 MVP에서 채널 사용 가능 | G1 지연, 6-2에 4행 추가, 어댑터 수동 증거 1건 추가 |
| C | 현행 유지(P0 문구에 채널 포함) | 문서 변경 0 | 수용 기준·지정 테스트가 채널을 검증하지 않아 G1 "PASS"가 문구와 어긋남 |

### 9-2. 문장 개정안 (★ A 기준)

| 파일:행 | 현재 문장(발췌) | 제안 문장 |
|---|---|---|
| `docs/02-prd/PRD.md:158` | "봇은 owner와의 Jarvis DM(과 owner가 지정한 채널)에만 참여하고, 서버 이벤트는 작성자 종류를 서버 값으로 싣는다" | "봇은 owner와의 Jarvis DM에만 참여하고(채널 참여는 P1 FR FR-BOT-08–11), 서버 이벤트는 작성자 종류를 서버 값으로 싣는다" |
| `docs/02-prd/PRD.md:161` 다음 | (없음) | FR-BOT-08–11 4행 추가(§7-2 표, 우선순위 P1) |
| `docs/02-prd/PRD.md` 변경 이력 | (없음) | "FR-BOT-03 문구에서 채널 괄호 삭제(우선순위·수용 기준 불변), FR-BOT-08–11 P1 추가 — BOT_CHANNEL_SPEC" |
| `docs/decisions/ADR-001-hermes-agent-integration.md:71` | "(채널 참여는 P1, owner가 웹에서 명시적으로 추가할 때만)" | "(채널 참여는 P1 FR FR-BOT-08–11, owner가 웹에서 명시적으로 추가할 때만 — `docs/09-specs/BOT_CHANNEL_SPEC.md`)" |
| `docs/decisions/ADR-001-hermes-agent-integration.md:73` | "봇이 채널에 참여하는 P1 단계에서도 owner 외 작성자 메시지는 …" | "봇이 채널에 참여하는 경우(P1 FR FR-BOT-10)에도 owner 외 작성자 메시지는 …" (단계/우선순위 혼동 제거) |
| `docs/decisions/ADR-001-hermes-agent-integration.md:80` | "P1에서 owner가 채널에 봇을 추가하면 Mattermost처럼 멘션 게이팅(`mattermost/adapter.py:506-526`)" | "P1 FR FR-BOT-10: owner가 채널에 봇을 추가하면 서버 `mention_user_ids` 기반 멘션 게이팅(참고 패턴 `plugins/platforms/mattermost/adapter.py:506-526`, 실제 경로 정정)" |
| `docs/decisions/ADR-001-hermes-agent-integration.md:176` | "멤버십 상한 + allowlist 이중 통제, 채널 참여는 P1" | "owner 명시 추가만 허용하는 멤버십 범위 + owner allowlist + 채널 멘션 게이팅, 채널 참여는 P1 FR(FR-BOT-08–11)" |
| `docs/03-trd/TRD.md:95` | "공개 채널 참여·나가기. 나간 뒤 구독 즉시 해제" | 행 유지 + 새 행 "`POST /api/conversations/{id}/bots`, `DELETE /api/conversations/{id}/bots/{bot_user_id}` \| owner가 참여 중인 공개 채널에 봇 추가·제거(access `conversation`, action `manage_bots`). 제거 뒤 봇 구독 즉시 해제" |
| `docs/03-trd/TRD.md:201` | "② owner가 웹에서 명시적으로 봇을 추가한 채널(P1)에만 참여합니다." | "② owner가 웹에서 명시적으로 봇을 추가한 공개 채널(P1 FR FR-BOT-08)에만 참여합니다. 수치 상한은 두지 않습니다(§10 Q6 결정). 채널에서 봇이 읽는 메시지는 참여 시점 `joined_seq` 이후입니다(§10 Q2 결정)." |
| `docs/03-trd/TRD.md:202` | "… `GET /api/bot/v1/me`, … 채널 join·멤버 추가 라우트는 없습니다." | "`GET /api/bot/v1/me`(`conversations[{id,kind}]`·`display_name` 추가) … 봇 토큰용 채널 join·멤버 추가 라우트는 없습니다." |
| `docs/03-trd/TRD.md` §4 이벤트 표 | (없음) | `membership.changed {conversation_id, state}` — 영향받는 봇 연결에만(§10 Q4 결정) |
| `docs/04-dev-design/DEV_DESIGN.md:133` | "P1 FR(기기 세션 목록·비공개 채널·일반 파일(FR-OPS-09)·검색·presence) 중 영환님이 고른 것" | "P1 FR(기기 세션 목록·비공개 채널·일반 파일(FR-OPS-09)·검색·presence·봇 채널 참여(FR-BOT-08–11)) 중 영환님이 고른 것" |
| `docs/04-dev-design/DEV_DESIGN.md:117` | `conversation` 메타 예시 라우트 목록 | 예시에 `POST`·`DELETE /api/conversations/{id}/bots…` 추가 |
| `docs/04-dev-design/DEV_DESIGN.md` §6 | (없음) | 새 절 "6-4. P1 선택 FR 매핑"(§7-3 표, 6-2와 같은 6열 머리) — §10 Q7 결정. 반영 시 6-6으로 둠(기존 6-4·6-5 번호 보존) |
| `docs/08-security/THREAT_MODEL.md:213` | "① 서버: 봇 멤버십은 owner와의 DM 1개(+owner가 지정한 채널)로 제한" | "① 서버: 봇 멤버십은 owner와의 DM 1개 + owner가 웹에서 명시적으로 추가한 공개 채널(P1 FR FR-BOT-08)로 제한 … ③-2 어댑터: 채널은 owner의 봇 멘션만(FR-BOT-10)" / 검증 열에 `FR-BOT-08`·`QA-FR-BOT-10` 추가 |
| `docs/08-security/THREAT_MODEL.md:214` | "owner가 붙여넣은 외부 텍스트·링크·이미지 안의 지시(간접 인젝션)" | "… 지시(간접 인젝션). 채널에서 owner가 인용·전달한 다른 멤버 글 포함" |
| `docs/runbooks/HERMES_BOT.md:107` | "채널이면 owner가 웹에서 봇 추가" | "채널이면 owner가 웹 채널 헤더에서 봇 추가(FR-BOT-11, 구현 후)" |
| `apps/server/test/bots/bot-scope.int.test.ts:9` 주석 | "owner DM + owner가 추가한 채널" 인용 | (코드 — 이 스펙 범위 밖) L1이 FR-BOT-08 구현 때 주석을 실제 경로와 맞춤 |

---

## 10. 결정 필요 사항

### 10-1. 영환님 결정 (★ 추천 먼저) — 2026-11-10 전부 ★ 채택

1. **Q1 FR-BOT-03·채널 우선순위** — **결정됨(2026-11-10, ★)** — ★ A(§9-1): DM 전용 P0 + 채널 P1 FR 4개. 근거: 구현·테스트·ADR H1–H4 어디에도 채널이 없음(§1-2), G1 범위 변화 0.
2. **Q2 봇 읽기 범위** — **결정됨(2026-11-10, ★)** — ★ 봇 행위자만 "참여 후 메시지 + 참여 후 시작된 스레드"로 제한(§4-5, 경로 7곳: REST 2·snapshot·sync·WS replay·WS 실시간·첨부). 대안: 사람과 같게 전체 이력. 근거: 최소 권한, 토큰 탈취 시 노출 축소(TM-BOT-01). 비용: 읽기·전달 경로 7곳 수정(L1 규모 L의 주원인), owner는 참여 전 스레드에서 봇을 부를 수 없음.
3. **Q3 권한 판정 위치** — **결정됨(2026-11-10, ★)** — ★ `conversation` 메타 + `AccessAction 'manage_bots'`를 `assertAccess` 안에서 판정(역할 owner + 활성 멤버 + 채널). 대안: `admin` 메타 가드 + `assertAccess(…,'read')` 두 번 검사. 근거: B2 "assertAccess 하나로만"(`docs/04-dev-design/DEV_DESIGN.md:90`).
4. **Q4 멤버십 추가 통지** — **결정됨(2026-11-10, ★)** — ★ N1 새 프레임 `membership.changed`(영향받는 봇 연결에만). 대안 N2 `sync.required` 재사용, N3 봇 WS 재연결. 근거: 의미가 명확하고 재연결 비용 0, 프레임 1종 추가(공유 스키마 변경).
5. **Q5 채널 스레드 답글의 멘션** — **결정됨(2026-11-10, ★)** — ★ 채널에서는 **모든 메시지(답글 포함)에 멘션 필수**. 대안: 봇이 답한 스레드는 멘션 없이 이어짐(어댑터가 세션 루트 집합을 cursor 파일에 저장해야 함). 근거: 상태 없음·재시작 안전·다른 멤버와의 대화 중 오작동 0. 비용: owner가 답글마다 `@Jarvis`를 붙여야 함.
6. **Q6 수치 멤버십 상한** — **결정됨(2026-11-10, ★)** — ★ 수치 상한 없음(owner 명시 추가만). 대안: 봇 채널 수 상한 N(새 상수 → 값 결정 필요). 근거: owner 1명·봇 1개, 정본에 수치 없음(`docs/03-trd/TRD.md:201`), 새 수치는 정본에서 정해야 함(`docs/04-dev-design/DEV_DESIGN.md:396`).
7. **Q7 P1 FR 판정 방법** — **결정됨(2026-11-10, ★)** — ★ 단계 P2 v1에서 고른 P1 FR은 DEV_DESIGN 새 절 6-4(6-2와 같은 머리)에 두고, `check:fr-coverage`가 6-4를 "선택된 P1 FR" 집합으로 읽도록 확장(L0·L1 중 하나가 체커+자체 테스트 수정). → 반영: 절 번호는 6-6, 체커 확장은 L1. 대안: 채택 시 P0로 승격해 6-2에 넣음. 근거: G2 "선택한 P1 FR의 테스트 매핑 추가·통과"(`docs/04-dev-design/DEV_DESIGN.md:133`)를 지금 체커는 판정하지 못함(P0만 수집).
8. **Q8 웹 문구** — **결정됨(2026-11-10, ★)** — ★ COPY_GAPS에 항목 추가 후 결정(봇 추가 버튼, 제거 확인 Dialog 제목·본문·확인 버튼, 추가 실패). 대안: 기존 「채널 나가기」 Dialog 문구 구조를 따라 Jarvis가 초안. 근거: 문구는 정본에서만 정함(`docs/04-dev-design/DEV_DESIGN.md:396`).

### 10-2. Jarvis 결정(★) — 이 스펙에서 확정 (저위험, 이의 있으면 뒤집기 쉬움)
1. 멘션 판정은 서버 `mention_user_ids`만, 본문 문자열 검색 없음(§5-2).
2. allowlist·free-response 채널 설정 없음 — 채널 범위는 서버 멤버십(§5-2).
3. 본문 맨 앞 `@<봇 표시 이름>` 토큰 1개만 제거(§5-3).
4. 모르는 대화(맵에 없음)의 메시지는 무시(§5-1).
5. 채널에서는 스레드 답글로만 송신, 루트 모르면 송신하지 않음(§5-6).
6. 홈 채널은 DM 고정(§5-5).
7. 게이팅 순서 owner → 종류·멘션 → dedupe → 15분; 게이팅 탈락은 백로그 미집계, 채널 백로그 안내는 DM으로(§5-7).
8. 수정으로 붙은 멘션은 실행 안 함(§5-2).
9. owner가 채널을 나가도 봇 멤버십 유지(§3-5).
10. 다른 사람 기기의 멤버 수 실시간 반영은 범위 밖(§4-7).
11. `sync.required` 처리 전 `/me` 재조회(§5-8).

---

## 11. 위험·미확인

### 11-1. 사실
- 현재 어댑터가 채널 멤버십을 얻으면 owner의 모든 채널 글을 DM 지시처럼 실행한다(`integrations/hermes-plugin/ohmyslack/adapter.py:206,222-224,345-348,372-373`). → §8 의존 순서로 통제.
- 봇 owner는 워크스페이스 owner 중 `ORDER BY user_id LIMIT 1`(`apps/server/src/modules/bots/repo.ts:190-196`). owner가 2명 이상이면 `manage_bots`를 통과한 다른 owner가 봇을 넣을 수 있지만 봇은 첫 owner의 글만 따른다.
- `check:fr-coverage`는 이 워크트리에서 실행할 수 없었다(`typescript` 패키지 없음, 의존성 설치 금지). 형식은 코드를 읽고 맞췄다(§7-1).
- 브리프가 지정한 mattermost 경로 `~/.hermes/hermes-agent/gateway/platforms/mattermost/adapter.py`는 없고 실제 경로는 `~/.hermes/hermes-agent/plugins/platforms/mattermost/adapter.py`(줄 506–526은 같음). ADR-001:80의 경로 표기도 같은 정정이 필요(§9-2).

### 11-2. 추정
- PRD:158 괄호는 ADR의 "P1"을 P0 행에 옮기며 생긴 표기 누락(§1-2).
- (정정) 참여 전 루트에 참여 후 답글이 달리면 현행 서버는 답글과 함께 **루트 projection을 `message.updated`로 다시 보낸다**(사실, `apps/server/src/modules/messages/service.ts:59-61,78`). 그래서 Q2 ★는 "참여 전 시작 스레드 통째 제외"로 정했다(§4-5). 부분 공개(답글만 보이고 루트 숨김)는 답글 API 계약(`root` 필수) 변경이 필요해 택하지 않았다.
- (Q2 ★ 채택으로 해당 없음 — 기록용) Q2를 채택하지 않았다면, 봇이 추가된 직후 sync·WS replay(`after_cursor` = 봇 watermark)로 참여 직전 채널 변경이 들어올 수 있다. 참여 전 글에는 봇 멘션이 저장될 수 없으므로(멘션 필터가 활성 참여자만, `apps/server/src/modules/messages/repo.ts:35-37`) 게이팅으로 실행은 0이다.
- 규모 S/M/L과 max-turns는 경험적 추정.

### 11-3. 확인 필요
1. Hermes 승인 파서가 본문 맨 앞 `/`를 요구하는지(§5-3 토큰 제거 필요성).
2. ~~봇 WS가 `membershipEnded`를 받는지~~ → 해소(사실): 봇 hub가 같은 `conversationEvents`를 구독(`apps/server/src/modules/bots/ws.ts:81`).
3. 웹 WS가 모르는 서버 프레임 `type`을 부작용 없이 무시하는지 — `switch`에 case가 없어 무시로 추정(`apps/web/src/data/http-source.ts:397-421`), 실행 확인은 L1·L3 테스트.
4. Hermes 런타임의 `group_sessions_per_user`·`thread_sessions_per_user` 설정값(§5-4).
5. Hermes 에이전트 도구 중 ohmyslack 채널 이력을 직접 읽는 경로가 있는지(§6 잔여 위험).
6. ~~`BotMe` 스키마 위치~~ → 해소(사실): `packages/shared/src/bots.ts:7-13`.
7. ADR-001·TRD의 맨 "P1"이 단계인지 우선순위인지 — 원저자 의도(§1-2 D8). ★ A 채택(2026-11-10)으로 "P1 FR"로 통일되어 해소.
