---
title: "ohmyslack 기술요구사항 — GPT-Luna"
tags: [ohmyslack, trd, architecture]
status: active
created: 2026-11-07
---

# TRD — ohmyslack (내부 코드명)

- 상태: R3 최종안 (R3.3 개정, 2026-11-08 ADR-001 채택; R3.5 문서 첨부 계약 §6-1-1, 2026-11-13 — 구현 대기; R3.6 정본 정합 — 415 하위 코드·텍스트 계열 첨부·기기 세션 계약, 2026-11-13 — 구현 대기; R3.7 첨부 표시 순서 = 요청 `attachment_ids` 순서·`attachments.bind_order`, 2026-11-14)
- 작성자: GPT-Luna
- 입력: BUZZ_ROUND2_DOCS.md, BUZZ_ROUND3_FINAL.md, PRD v1.3(R3.3 반영), `docs/decisions/ADR-001-hermes-agent-integration.md`, R1 개발설계서·디자인 레퍼런스, GPT-Sol·Claude-Opus·Claude-Fable R2 리뷰
- 정합성: FR ID·우선순위·수용 기준은 PRD 정본을 따릅니다. 저장소·단계·테스트 계약은 개발설계서 정본을 따르고, 토큰·브레이크포인트·레이아웃·컴포넌트·IME 규칙은 디자인 레퍼런스 정본을 따릅니다.

## 1. 시스템과 범위

확정 방향은 개인 전용 메신저입니다. 영환님 계정 하나로 Mac·다른 Mac·휴대폰이 로그인하며, 앱 인증과 Tailscale 접근 인증은 별개입니다. Mac에서 단일 Fastify 프로세스와 PostgreSQL을 구동합니다. DB가 대화·메시지·읽음 상태의 단일 원장이고 WebSocket은 best-effort 알림 경로입니다. 모바일 웹과 PWA는 MVP입니다.

~~~text
[Mac / iPhone browser or PWA]
  ├─ HTTPS REST ─────────────┐
  └─ WSS / same-origin cookie ┤
                              v
                  [Tailscale Serve HTTPS]
                    tailnet-only reverse proxy
                              │ → 127.0.0.1
                              v
              [Fastify static UI + REST + WS]
                              │
                              v
                  [PostgreSQL single ledger]
            messages + global changes + read cursors

[Hermes gateway (same Mac)] ── Bearer ──► 127.0.0.1:<BOT_PORT>
                    [bot listener: /api/bot/v1/** + WS]   (Serve 대상 아님, §5-2)
[Fastify] ── outbound HTTPS ──► [Web Push service]       (§6-2)
~~~

스택은 React + TypeScript + Vite, Node.js + Fastify, PostgreSQL, 같은 앱의 PWA입니다. 설치 기록의 Node 26.12.1은 확인된 설치 버전이지 승인된 runtime pin은 아닙니다. 목표 major는 Node 26이며, 착수 때 공식 Node.js release 표에서 26.x가 지원 LTS인지 확인하고 그 LTS 최신 보안 패치의 정확한 버전을 `.nvmrc`, `engines`, CI, lockfile에 함께 고정합니다. 26.x가 아직 지원 LTS가 아니면 당시 지원 중인 LTS major를 사용하고 이 문서를 갱신합니다. PostgreSQL 운영 버전과 연결 경계는 착수 전 확인 항목입니다.

MVP는 본인 다기기 대화 동기화, 합성 계정으로 초대·DM 권한 검증, 채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·실시간·복구·모바일 PWA입니다. 타인 초대/tailnet 추가는 별도 승인입니다. Redis, Slack API/브리지, 지속(영구) 오프라인 발신 큐, 사용자 본문 지속 캐시, 검색, presence, 네이티브 앱, Electron은 MVP 의존성에서 제외합니다. **최소 첨부(§6-1)·Web Push(§6-2)·Hermes 봇(§5-2)은 v1.3에서 MVP에 포함**하며 일반 파일은 제외합니다.

## 2. 데이터 모델

UUID는 공개 개체 ID, `timestamptz`는 UTC 시각입니다. 아래는 구현 가능한 제약의 계약이며, 구체적인 migration 문법은 개발설계서의 저장소 규칙을 따릅니다. 모든 FK는 아래에서 정한 `ON DELETE`를 사용합니다. 사용자를 비활성화할 때는 `users.status`만 바꾸며, `workspace_members`에는 중복 status를 두지 않습니다.

| 테이블 | 주요 필드·제약 | 역할 |
|---|---|---|
| `workspaces` | `id uuid PK`, `name text NOT NULL`, `created_at timestamptz NOT NULL` | 고정 1개. 참조 FK는 `ON DELETE RESTRICT` |
| `users` | `id uuid PK`, `email_norm text UNIQUE NOT NULL`, `display_name text NOT NULL`, `password_hash text NULL`, `status text NOT NULL CHECK (status IN ('active','disabled'))`, `kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','bot'))`, `CHECK ((kind='human') = (password_hash IS NOT NULL))` | 실제 계정 1명과 합성 계정, 봇 계정(§5-2). 비활성화의 기준 필드. 봇의 `email_norm`은 `<slug>@bot.invalid`(RFC 2606 예약 TLD, 로그인 불가 식별자) |
| `workspace_members` | `workspace_id`, `user_id`, `role text CHECK (role IN ('owner','member')) NOT NULL`, composite PK, 두 FK `ON DELETE RESTRICT` | 단일 workspace 멤버십·관리 권한 |
| `invites` | `id uuid PK`, `token_hash text UNIQUE NOT NULL`, `created_by uuid NOT NULL`, `expires_at timestamptz NOT NULL`, nullable `used_at timestamptz`, nullable `revoked_at timestamptz` | 만료·1회 사용. 사용자 FK `RESTRICT`, token 원문 미저장 |
| `sessions` | `id uuid PK`, `user_id uuid NOT NULL`, `token_hash text UNIQUE NOT NULL`, `created_at timestamptz NOT NULL`, `last_seen_at timestamptz NOT NULL`, `expires_at timestamptz NOT NULL`, nullable `revoked_at timestamptz`, nullable `device_label text`(R3.6, `CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 64)`) | 기기별 세션. 사용자 FK `ON DELETE CASCADE`. `device_label`은 §5-3 생성 규칙의 거친 라벨만(원문 User-Agent·IP 저장 0), 마이그레이션 ★`0006_session_device_label.sql`(1c 구현 시 반영, 기존 행은 NULL) |
| `conversations` | `id uuid PK`, `workspace_id uuid NOT NULL`, `kind text CHECK (kind IN ('channel','dm')) NOT NULL`, nullable `name text`, nullable `name_norm text`, nullable `normalized_pair_key text`, `last_seq bigint NOT NULL DEFAULT 0`, `created_at timestamptz NOT NULL`; unique `(workspace_id,id)` | `workspace_id` FK `RESTRICT`; 채널은 `(workspace_id,name_norm)` 부분 unique; DM은 `normalized_pair_key` 부분 unique |
| `conversation_members` | `(conversation_id,user_id)` PK, `joined_at`, `joined_seq bigint`, nullable `left_at` | 양 FK `RESTRICT`; 재참여 시 `joined_seq=last_seq`로 갱신. 접근은 현재 `left_at IS NULL`만 허용 |
| `messages` | `id uuid PK`, `conversation_id uuid NOT NULL`, `seq bigint NOT NULL`, `author_id uuid NOT NULL`, `client_message_id uuid NOT NULL`, nullable `thread_root_id uuid`, nullable `body text`, `created_at timestamptz NOT NULL`, nullable `edited_at timestamptz`, nullable `deleted_at timestamptz`; unique `(conversation_id,id)`, `(conversation_id,seq)`, `(conversation_id,author_id,client_message_id)` | 대화 FK `RESTRICT`, 작성자 FK `RESTRICT`, `(conversation_id,thread_root_id)` 자기참조 FK `RESTRICT`; tombstone 외에는 body NOT NULL |
| `sync_clock` | singleton `id integer PRIMARY KEY CHECK(id=1)`, `last_change_id bigint NOT NULL DEFAULT 0` | 전역 커서 할당 잠금 행. 서비스 시작 시 1행 생성 |
| `conversation_changes` | `change_id bigint UNIQUE NOT NULL`, `conversation_id uuid NOT NULL`, `message_id uuid NOT NULL`, `op text CHECK (op IN ('create','edit','delete')) NOT NULL`, `created_at timestamptz NOT NULL` | 전역 변경 로그. message FK `RESTRICT`; 메시지 본문·mention snapshot은 저장하지 않음 |
| `conversation_read_state` | `(conversation_id,user_id)` PK, `last_read_seq bigint NOT NULL`, `updated_at` | 대화 본문 읽음 위치 |
| `thread_read_state` | `(root_message_id,user_id)` PK, `last_read_seq bigint NOT NULL`, `updated_at` | 스레드별 읽음 위치. root FK `RESTRICT` |
| `thread_unread_targets` | `(root_message_id,user_id)` PK, `qualified_at timestamptz NOT NULL` | PRD §7-7의 스레드 대상 자격을 기록; 편집·삭제 뒤에도 자격 유지. root/user FK `RESTRICT` |
| `message_mentions` | `(message_id,user_id)` PK | 메시지와 멤버 FK `RESTRICT`; 수정 시 재계산, 삭제 시 같은 트랜잭션에서 제거 |
| `bot_tokens` | `id uuid PK`, `bot_user_id uuid NOT NULL` FK users `ON DELETE CASCADE`, `token_hash text UNIQUE NOT NULL`(SHA-256), `label text NOT NULL`, `created_at`, nullable `last_used_at`, nullable `revoked_at`; 부분 unique: 봇당 미폐기 토큰 **최대 2개**(회전 겹침용, 서비스 검사) | 봇 인증(§5-2). 원문 미저장 |
| `attachments` | `id uuid PK`, `conversation_id uuid NOT NULL`, `uploader_id uuid NOT NULL`, nullable `message_id uuid`(결속 전 NULL), `mime text CHECK (mime IN ('audio/mpeg','image/png','image/jpeg','image/webp'))`, `byte_size integer CHECK (byte_size BETWEEN 1 AND 10485760)`, `sha256 text NOT NULL`, nullable `duration_ms`/`width`/`height`, `created_at`, `expires_at timestamptz NOT NULL`, nullable `deleted_at` | 첨부 메타데이터(§6-1). `(conversation_id,message_id)`→messages 복합 FK `RESTRICT`. 문서 확장(`filename`·`has_macros`·MIME 12종 = 문서 9 + 텍스트 3·상한 26,214,400)은 §6-1-1 마이그레이션 `0005`(1b 구현 시 반영). nullable `bind_order smallint`(R3.7, 마이그레이션 `0007`): 결속 때 요청 `attachment_ids`에서의 0부터 위치. 0007 이전에 결속된 행은 NULL(백필 없음) |
| `attachment_blobs` | `attachment_id uuid PK` FK `ON DELETE CASCADE`, `bytes bytea NOT NULL` | 바이트 분리 저장(목록 조회가 bytea를 읽지 않게). 보존 만료·메시지 삭제 시 행 삭제 |
| `push_subscriptions` | `id uuid PK`, `user_id uuid NOT NULL` FK `CASCADE`, `session_id uuid` FK sessions `CASCADE`, `endpoint text UNIQUE NOT NULL`, `p256dh text NOT NULL`, `auth text NOT NULL`, `vapid_key_id text NOT NULL`, `created_at`, nullable `last_success_at` | 기기(세션)별 구독(§6-2). 로그아웃·세션 폐기 시 함께 삭제 |
| `metric_daily` | `day date`, `event text`, `dims jsonb`(검증된 allowlist 필드만), `count integer` — PK `(day, event, dims)` | 로컬 계측 일 단위 집계(PRD §10, 마이그레이션 0009). 식별자·본문 열 없음. 일자는 UTC, 오늘 포함 7일 밖 행은 기동 시·24시간마다 삭제. 서버는 프로세스 메모리에서 합산한 뒤 주기 flush(`METRIC_FLUSH_INTERVAL_MS`)로 행마다 `count + n`을 올리고, 종료 시 마지막 flush를 시도한다(실패분은 다음 flush에 재합산하는 최선 노력, 버퍼 키 상한 `METRIC_MAX_KEYS`). 저장 호출 1회는 쓰기 상한 `METRIC_WRITE_TIMEOUT_MS`(flush 주기보다 짧음)로 끊어 실패·재합산하고, 계측 쿼리는 트랜잭션 로컬 서버측 `statement_timeout`(`METRIC_STATEMENT_TIMEOUT_MS` < 쓰기 상한)으로 DB에서 취소된다(pool 전역 설정 불변). 포기했지만 정착하지 않은 저장 호출이 `METRIC_MAX_ABANDONED`(2)개면 그 주기 저장을 건너뛴다(계측이 쥐는 연결·대기 자리 기록기 단독 ≤ 2·retention 겹침 시 ≤ 3, 정착하지 않으면 정지하되 주기마다 `metric_write_failed`). 상한(연결 대기 포함)이 COMMIT 왕복과 겹치면 그 flush의 1행이 과대 집계될 수 있다(상한 초과 flush마다 최대 1행) |

모든 `id`, `*_id`, `user_id`, `conversation_id`, `workspace_id`는 `uuid NOT NULL`이며 PK/FK 구성 컬럼은 예외 없이 타입이 일치합니다. 식별·관계 컬럼은 PK, FK, nullable 표기가 없는 한 `NOT NULL`입니다. 시각은 `timestamptz NOT NULL`(nullable로 표시된 종료·폐기 시각 제외), 정렬·읽음·변경 cursor는 `bigint NOT NULL`입니다. enum은 표의 `CHECK` 허용값으로 제한합니다. `name_norm`은 channel 행에서 필수, `normalized_pair_key`는 DM 행에서 필수입니다. `messages.body`/`deleted_at` 조합은 미삭제 본문 또는 삭제 tombstone만 허용합니다.

필수 인덱스: `messages(conversation_id,seq DESC)`, `messages(conversation_id,thread_root_id,seq)`, `conversation_changes(change_id)`, `conversation_changes(conversation_id,change_id)`, `conversation_members(user_id,conversation_id)`, `message_mentions(user_id,message_id)`, `attachments(message_id)`, `attachments(expires_at) WHERE deleted_at IS NULL`, `bot_tokens(bot_user_id) WHERE revoked_at IS NULL`. 메시지 본문은 `text NOT NULL`이며 `length(body) <= 4000`; 삭제 행은 `body IS NULL AND deleted_at IS NOT NULL`입니다. 빈 메시지는 거부합니다. **첨부 메시지도 비어 있지 않은 본문을 가집니다**(FR-MSG-01 불변, ADR-001 §3-g 선택 b) — 어댑터는 caption 또는 파일명, 웹은 자리 문구로 채웁니다. 길이는 Unicode code point 기준입니다.

채널 이름은 앞뒤 공백을 제거하고 Unicode NFC 정규화 후 case-fold한 `name_norm`으로 유일성을 검사합니다. DM 쌍 키는 두 사용자 UUID를 정렬해 만든 고정 표현이며, 두 사용자 멤버십은 생성 트랜잭션에서 함께 만듭니다. `thread_root_id` 복합 FK는 `(conversation_id,id)` unique key를 참조하며 원문은 같은 대화에 있어야 하고 그 원문 자체는 `thread_root_id IS NULL`이어야 합니다. 복합 FK와 서비스 검증으로 대화 경계를 보장하고, root가 답글인 입력은 거부합니다. 물리 삭제 대신 tombstone을 사용합니다.

메시지 생성·수정·삭제는 membership 확인과 관련 row 잠금, 메시지·mention·change 기록을 단일 트랜잭션으로 처리합니다. 메시지별 `seq`는 conversation 행 잠금 안에서 증가합니다. 전역 `change_id`는 매 변경 트랜잭션에서 `sync_clock` singleton row를 갱신해 할당합니다. 이 row 잠금은 직전 변경 트랜잭션이 commit/rollback할 때까지 유지되므로 커서 순서가 commit 순서와 일치합니다. PostgreSQL sequence의 할당 순서에 기대지 않습니다. 메시지 변경과 커서 갱신은 원자적입니다. 같은 `(conversation_id, author_id, client_message_id)`와 같은 payload 재시도는 원래 결과를 반환하고, 다른 payload는 409입니다. ACK와 WS 알림은 commit 이후에만 발생합니다.

수정 이력은 `conversation_changes`의 본문 없는 식별자·op 기록과 현재 `messages` 상태를 함께 사용합니다. sync는 변경 row를 그대로 내보내지 않고 페이지 내 message id를 모아 현재 상태로 접습니다. 삭제된 메시지는 body와 mention이 없는 tombstone으로만 응답하고, 삭제 트랜잭션은 mention row를 제거합니다. 따라서 삭제 이후 과거 커서부터 여러 페이지를 재생해도 본문 snapshot이 재등장하지 않습니다. 백업 보존 중인 과거 사본 제거는 서비스 sync replay와 별개인 보존 정책입니다.

읽음 상태는 계정 기준 `max(current, request)`로만 증가합니다. 멤버십 생성/재참여 때 `joined_seq=conversations.last_seq`를 저장하고 본문 read cursor도 이 값으로 초기화해 이전 대화가 신규 unread가 되지 않게 합니다. seq 숫자에 중간 값이 없어도 원문/답글/삭제로 생긴 정상 간격이므로, read cursor는 현재 화면에서 정렬된 대상 종류의 마지막 표시 메시지로 판정합니다. 사용자가 원문을 작성하거나 답글을 작성하거나 다른 사용자가 보낸 메시지에서 mention을 받으면 해당 `(root_message_id,user_id)`를 `thread_unread_targets`에 삽입합니다. 스레드 read-state가 없는 대상 사용자는 초기 cursor를 `joined_seq`로 취급하므로 멤버십 이후의 접근 가능한 답글을 unread로 셉니다. 자격을 얻은 뒤 mention/답글이 수정·삭제돼도 대상 행은 유지하며, 접근을 잃으면 목록/집계에서 제외합니다. 단순히 스레드를 열어 본 것은 대상 자격을 만들지 않습니다. read cursor가 이미 더 앞서 있으면 뒤로 이동시키지 않습니다. 본문 읽음은 실제 화면에서 마지막으로 연속 표시한 top-level `seq`, 스레드 읽음은 해당 root의 실제 답글 중 마지막 연속 표시 위치여야 합니다. 서버는 대상 대화/root의 membership, root가 top-level인지, 요청 seq가 그 범위에서 실제로 존재하는 최대 seq 이하인지 확인하고 범위 밖 요청은 400으로 거부합니다. 자기 메시지와 삭제 tombstone은 unread에서 제외합니다.

## 3. HTTP 계약

모든 요청은 same-origin JSON, UUID, UTC RFC3339를 사용합니다(첨부 업로드 body는 원시 바이트, §6-1; 봇 리스너 요청은 §5-2). 사용자 권한은 서버 세션으로 결정하고 body의 `user_id`를 권한 판정에 사용하지 않습니다. 목록은 cursor paging, 최대 100개이며 offset은 금지합니다. 오류는 `{error:{code,request_id}}`이며 본문·token·SQL·stack을 포함하지 않습니다.

| Route | 계약·권한 |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout` | 로그인·현재 기기 로그아웃. DB 세션 즉시 revoke |
| `GET /api/me`, `GET /api/sessions` | 현재 계정·기기 세션. `GET /api/sessions`(`access: account`)는 `{sessions:[{id,device_label,created_at,last_seen_at,current}]}` — 본인의 살아 있는 세션만(남의 세션·폐기·만료 세션 미포함), `device_label: string \| null`(§5-3), `current: boolean`(요청 세션 여부). R3.6 계약(1c 구현 대기) |
| `DELETE /api/sessions/{id}` | R3.6, P1 FR-AUTH-04(1c 구현 대기). `access: account`, CSRF·Origin 통제는 다른 상태 변경과 동일. 본인 세션만 폐기 → 204. 남의 세션 ID·없는 ID는 404(존재 오라클 0 — 둘을 구분하지 않음), 이미 폐기·만료된 본인 세션은 204(멱등), 현재 요청 세션 ID는 400(`POST /api/auth/logout` 사용). 폐기 후 5초 안 그 세션의 WS close + 그 세션의 push 구독 삭제(§5-3). 「다른 기기 모두」 일괄 라우트는 두지 않음(UI-D11) |
| `POST /api/invites`, `POST /api/invites/accept` | owner 발급, 만료/1회 token 원자적 교환; 외부 메일 없음 |
| `POST /api/invites/{id}/revoke` | owner 전용 초대 폐기(§5-1 S3) |
| `GET /api/members` | 활성 멤버 목록(초대·DM·멘션 후보). 본인 계정 세션 필요 |
| `GET /api/users/names?ids=` | 같은 워크스페이스 사용자 이름(비활성 포함) `{users:[{id,display_name,status,kind}]}`. UUID 1–100개(초과·형식 오류 400), 없는 ID는 빠질 뿐 200. 본인 계정 세션 필요, 봇 리스너 미노출 |
| `POST /api/admin/members/{user_id}/deactivate` | owner 전용. `users.status=disabled`, 세션 revoke, WS close |
| `GET /api/conversations` | 현재 접근 가능한 대화와 unread 요약. 대화별 추가 unread 호출 금지 |
| `GET /api/conversations/discover?after=&limit=` | 아직 참여하지 않은 공개 채널 목록. join 전에는 메시지·멤버 정보를 반환하지 않음 |
| `POST /api/conversations` | `{kind:"channel",name}` 채널 생성. owner 전용(PRD FR-CONV-01) |
| `POST /api/conversations/{id}/join`, `DELETE /api/conversations/{id}/membership` | 공개 채널 참여·나가기. 나간 뒤 구독 즉시 해제 |
| `DELETE /api/conversations/{id}` | 공개 채널 소프트 삭제(P1 FR FR-CONV-06, 마이그레이션 `0008`: `conversations.deleted_at`·`deleted_by`, 채널 이름 유니크는 `deleted_at IS NULL` 부분 인덱스). 본문 없음 → 204. `access: conversation`(action `delete`, `assertAccess` 단일 판정): owner만 허용(멤버 여부 무관), 비owner 멤버 403 `forbidden`, 비멤버·없는 ID·이미 삭제 404 `not_found`, DM 400 `invalid_request`(DM 비멤버 owner는 404). 메인 리스너 전용(봇 리스너 미등록). 삭제된 대화는 접근 판정·목록·discover·join·전송 잠금에서 없는 대화와 같다. commit 후 기존 멤버의 구독을 끊고 `conversation.deleted`(사람)·`membership.changed left`(봇)를 보냄. `conversation_changes`에는 기록하지 않음(오프라인 기기는 재연결 시 목록으로 정합) |
| `POST /api/conversations/{id}/bots`, `DELETE /api/conversations/{id}/bots/{bot_user_id}` | owner가 참여 중인 공개 채널에 봇 추가·제거(access `conversation`, action `manage_bots`, P1 FR FR-BOT-08). 추가 201·이미 멤버 200, 제거 204(멱등). 제거 뒤 봇 구독 즉시 해제 |
| `POST /api/dms` | `{user_id}`로 DM 시작. 정렬된 pair key로 동시 중복 생성 방지 |
| `GET /api/conversations/{id}/members` | 활성 참여자 목록. 참여자만 접근 |
| `GET /api/conversations/{id}/messages?before_seq=&after_seq=&around_seq=&limit=` | 접근 가능한 대화 이력. `roots_only=true`로 본문만, 기본 최대 100건 |
| `GET /api/messages/{root_id}/replies?before_seq=&after_seq=&limit=` | 1단 답글 목록. root 대화 접근 검사 |
| `GET /api/messages/{id}/preview` | push 알림 본문용 평문 미리보기 `{text: string \| null}`(§6-2, shared `messagePreviewResponseSchema`). 접근 판정은 replies와 같은 `message` 메타·`read`(비참여자·없는 ID 404, 미인증 401). 서버가 마크다운 표식을 걷어 낸 평문을 최대 100 code point(초과 시 `…`)로 자르고, 삭제·평문 없음은 `null`. `Cache-Control: no-store`, 로그·계측 0. 메인 리스너 전용(봇 리스너 미등록) |
| `POST /api/conversations/{id}/messages` | `{client_message_id,body,thread_root_id?,attachment_ids?}`; 생성 메시지(`client_message_id` 포함)·seq·global `change_id` 반환. `attachment_ids`는 최대 4개, 같은 요청자가 올리고 아직 결속되지 않은 같은 대화 첨부만(§6-1). 멱등 payload 비교에 포함(첨부 ID **집합** 비교 — 순서만 바꾼 같은 키 재시도는 원결과·첫 요청의 순서를 반환). **R3.7:** 응답·이력·답글·`GET /api/sync`·WS 이벤트(사람·봇 경로 공통)의 `attachments` 배열은 이 요청 `attachment_ids`의 순서입니다. 같은 ID가 두 번 든 새 요청은 지금처럼 400 `invalid_attachments`(결속 0)이므로 순서는 첫 등장 위치 = 유일 위치입니다 |
| `POST /api/conversations/{id}/messages` — 비활성 상대 DM | DM 상대(보내는 사람 외 멤버, 봇 owner DM의 봇 포함)가 비활성이면 루트·답글 모두 403 `forbidden`(새 오류 코드 없음). DB·이벤트·push 변화 없음. 판정 전에 같은 멱등 키 재시도는 원결과를 반환. 편집·삭제·읽기·읽음·첨부 업로드/다운로드는 변경 없음 |
| `PATCH /api/messages/{id}` | 작성자만 수정. 새 `change_id`, 수정된 mention ID 반환 |
| `DELETE /api/messages/{id}` | 작성자만 tombstone 처리. 과거 본문/mention replay 방지 |
| `GET /api/sync?after={change_id}&through={change_id?}&limit=` | 계정 전역 catch-up. 첫 페이지에서 watermark `through_cursor` 확정, 후속 페이지에 그대로 전달 |
| `GET /api/sync/snapshot?conversation_id=&before_seq=&limit=` | cursor 만료(410) 또는 새 기기 초기화. 응답에 요청 시작점의 `snapshot_cursor`, 선택 대화의 현재 메시지 상태 페이지, `has_more`와 `next_before_seq` 포함 |
| `PUT /api/read-state` | `{conversation_id,thread_root_id?,last_read_seq}`; 유효 위치 검사 후 단조 병합 |
| `GET /api/healthz` | 비민감 상태만 공개 |
| `POST /api/metrics` | PRD §10 2단계 클라이언트 계측 수집. `access: account`(쿠키 세션 + Origin·CSRF, 다른 상태 변경과 동일), 메인 리스너 전용(봇 리스너 미등록). 본문 `{records:[{event,dims,n}]}`(shared `clientMetricBatchSchema`, 본문 8KB·records 32개 상한, 넘으면 413·400). 8KB 초과 본문은 본문 파싱 단계라 인증(세션·CSRF) 전에 413이다(Host·Origin은 그보다 먼저 적용, 파싱 비용은 8KB로 유계). event는 클라이언트 3종(`sync_result`·`read_sync_result`·`client_state`)만, dims는 `toMetricRecord` allowlist(enum·구간값), `n`은 1..100 정수 — 위반 레코드는 개별로 버리고 202 `{"status":"accepted"}`(입력 반향 없음). 사용자별 분당 증분 합 300·창당 서로 다른 (event, dims) 키 64 초과분은 버림(고정 코드 `metric_client_limited` 창당 1회). 기록은 서버 기록기 메모리 합산 → 주기 flush(`metric_daily`). `Cache-Control: no-store` |
| `POST /api/attachments?conversation_id=` | conversation write. 원시 바이트 body + `Content-Type`; 미결속 `attachment_id` 반환(§6-1). 문서·텍스트는 `X-Attachment-Filename` 필수(§6-1-1). 웹 클라이언트의 이 요청은 웹 요청 20초 상한(`REQUEST_TIMEOUT_MS`, `apps/web/src/data/api.ts:44`, PR #31 `55ac812`)에서 **면제**됩니다(원시 바이트 요청은 마감 없이 보냄 — `api.ts:89`). 업로드 취소는 사용자의 「첨부 제거」(요청 abort)뿐입니다(UI-D4, UI_STATES §2-13) |
| `GET /api/attachments/{id}` | `access: attachment`(첨부의 대화 read 검사). HTTP Range(206) 지원, 응답 헤더는 §6-1 |
| `GET /api/push/vapid-public-key` | account. VAPID 공개키; push 비활성 시 404(§6-2) |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions/{id}` | account. 현재 세션 기기의 구독 등록·해제(§6-2) |

`GET /api/conversations` 각 항목은 `last_seq`, `last_read_seq`, `unread_count`, `mention_count`, `unread_thread_count`, `unread_threads[{root_message_id,last_read_seq,last_reply_seq,unread_reply_count,mention_count}]`를 포함합니다. 본문 `unread_count`는 읽지 않은 top-level 원문만 셉니다. `unread_threads`는 PRD §7-7에서 정한 자격이 있는 스레드만 포함하고, 대상별 `unread_reply_count`는 자기 답글·삭제 답글을 제외합니다. `mention_count`는 본인이 작성하지 않은 접근 가능 미열람 원문/답글에서 본인을 대상으로 한 mention만 세며, 본문 수에 스레드 수를 더하지 않습니다. 이 목록 응답은 사이드바 badge와 복귀 후 read-state snapshot의 데이터원이며 N+1 unread 요청을 만들지 않습니다. 답글 화면은 replies 응답과 사용자 read state로 표시합니다.

`/api/sync`는 전역 커서 기준으로 요청 `limit`은 1–500으로 제한하며 페이지당 최대 500개 change row를 스캔하고 `scanned_through`, `through_cursor`, `has_more`, `next_cursor`를 반환합니다. 현재 membership이 있는 대화의 변경만 payload에 싣고, cursor 자체는 모든 row를 안전히 스캔한 위치까지 전진시킵니다. 첫 페이지의 watermark는 해당 요청 시작 시점의 마지막 commit cursor입니다. 후속 페이지는 그 watermark까지만 읽으며, watermark에 도달하면 다음 동기화부터 더 새로운 변경을 읽습니다. 적용 키는 `change_id`; 메시지 projection은 message id와 최신 `seq/edited_at/deleted_at`을 사용해 중복 적용에 안전합니다. cursor가 보존 경계보다 오래됐으면 410을 반환합니다.

새 기기에 저장된 sync checkpoint가 없으면 먼저 현재 conversation list와 read snapshot을 읽고, 활성 대화별 `GET /api/sync/snapshot?conversation_id=...`에서 최근 100개 메시지 단위의 현재 상태를 채웁니다. 오래된 이력은 일반 messages paging으로 요청합니다. 첫 snapshot 응답의 `snapshot_cursor` 이후 모든 대화 snapshot 완료까지 `/api/sync?after=snapshot_cursor`로 다시 catch-up하고, conversation list/read snapshot을 한 번 더 읽은 뒤 catch-up watermark를 기기 checkpoint로 저장합니다. cursor 만료(410)도 같은 절차를 사용합니다. 체크포인트는 기기별 숫자 metadata만 저장할 수 있고 메시지 본문·인증 응답은 지속 저장하지 않습니다. 이 절차가 끝날 때까지 UI는 최신으로 표시하지 않습니다.

상태 코드는 400 입력/범위 오류, 401 인증 또는 비활성 계정, 403 참여자가 관리자 권한/타인 메시지 쓰기를 요청한 경우, 404 비멤버가 대화 단위 자원에 접근한 경우(존재 은폐), 409 멱등 충돌, 410 만료 cursor, 413 첨부 상한 초과(§6-1), 415 허용목록 밖 첨부 형식(§6-1), 429 로그인 제한·봇 rate limit(§5-2)·사람 동시 업로드 상한(§6-1-1), 5xx 일반 오류입니다. 모든 route에 schema와 payload 상한 검증을 적용합니다.

415 하위 코드(R3.6): 첨부 업로드의 415는 `{error:{code,request_id}}`의 `code`로 아래 4개 중 하나를 냅니다(사람·봇 업로드 라우트 공통, 본문·파일명 미포함). 판정 순서는 §6-1-1 (4)를 따르고 한 요청에는 처음 걸린 사유 하나만 보냅니다.

| `code` | 조건 | 웹 표시(UI_STATES §2-13) |
|---|---|---|
| `unsupported_media_type` | 허용목록 밖 형식, 판정기 0개 일치·2개 이상 일치(폴리글랏), 선언 `Content-Type` 불일치, 판정기 자원 상한 초과·ZIP64·분할, 텍스트 판정 실패(유효 UTF-8 아님·NUL 포함) | G-54 형식 문구 |
| `extension_mismatch` | 원 파일명 확장자가 판정 형식의 허용 확장자가 아님(일반) | G-54 형식 문구(전용 문구 없음) |
| `macro_extension_mismatch` | 매크로가 감지된 OOXML이 `.docx/.xlsx/.pptx` 확장자로 옴 | G-56 |
| `encrypted_document` | 암호 걸린 문서(OLE `EncryptionInfo`·`EncryptedPackage`, ZIP 암호화 플래그) | G-54 형식 문구(전용 문구 없음) |

웹은 모르는 415 `code`(코드 없음 포함)를 G-54로 표시합니다. 미디어(§6-1) 업로드의 415도 `unsupported_media_type`입니다.

## 4. WebSocket·동기화

Endpoint는 same-origin `/api/ws`입니다. handshake에서 cookie session, 정확한 Origin, 활성 사용자 확인을 합니다. 모든 대화 접근은 개발설계서 정본의 `conversations.service.assertAccess(userId, conversationId, action)` 단일 경계를 통과합니다. 봇 연결은 §5-2의 **별도 봇 리스너** `/api/bot/v1/ws`에서 같은 이벤트 스키마를 씁니다. handshake는 `Authorization: Bearer`이며 쿠키·Origin을 받지 않습니다.

| 이벤트 | 방향·필드 |
|---|---|
| `conversation.subscribe` | client→server: `conversation_id`, `after_cursor`(마지막 완료된 sync checkpoint) |
| `conversation.subscribed` | server→client: `conversation_id`, `through_cursor` ACK |
| `message.created` | server→client: `conversation_id`, `change_id`, `message{id,seq,author_id,author_kind,client_message_id,thread_root_id,body,created_at,mention_user_ids,root_reply_count?,attachments[{id,mime,byte_size,duration_ms?,width?,height?,expires_at,expired:boolean}]}`; `author_kind`는 `users.kind`에서 서버가 채움(이력·sync projection 동일). 첨부 projection은 바이트 삭제 후에도 메타데이터를 유지하며 `expires_at`(보존 기한)과 `expired`(바이트 삭제됨 = `deleted_at` 존재 또는 `expires_at` 경과)를 이력·sync·이벤트에 공통으로 싣습니다. `expired=true`면 바이트 라우트는 404이고 웹은 만료 자리표시자를 그립니다(UI_STATES §2-5) |
| `message.updated` | server→client: `conversation_id`, `change_id`, 현재 message projection(`author_kind`·`attachments` 포함) 및 `mention_user_ids` |
| `message.deleted` | server→client: `conversation_id`, `change_id`, `message_id`, `seq`, `deleted_at`; body·mention 없음 |
| `read.updated` | server→client: `conversation_id`, `thread_root_id?`, `last_read_seq`, `updated_at`; null root은 본문 읽음 |
| `sync.required` | server→client: REST catch-up 수행 지시 |
| `membership.changed` | server→client: `conversation_id`, `state: 'joined' \| 'left'`. 영향받는 봇의 모든 연결에만 보냄(대화 구독자 팬아웃 아님, P1 FR FR-BOT-09). `left`는 기존 멤버십 종료 처리(`error not_found` + 구독 삭제) 뒤에 보냄 |
| `conversation.deleted` | server→client: `conversation_id`. owner가 채널을 삭제했을 때(P1 FR FR-CONV-06) 그 채널에 멤버 행이 있었던 사람 사용자 전원(먼저 나간 사람 포함)과 삭제를 요청한 owner의 모든 연결에 보냄(중복 제거). 기존 구독 종료(`error not_found` + 구독 삭제) 뒤에 보냄. 봇은 삭제 시점 활성 봇의 연결에만 대신 `membership.changed left` |
| `error` | 비민감 `code`, `retryable` |

메시지 read/history 응답과 create/update 이벤트는 `mention_user_ids: uuid[]`를 제공하며, 본문 속 `@이름`은 표시용입니다. 멘션 집계는 ID 배열과 `message_mentions`를 기준으로 합니다. 답글 생성은 `root_reply_count`를 갱신해 이벤트 및 root 응답에 반영하며, 삭제된 답글은 이 수에서 제외합니다. 원문·답글 작성 및 수신 mention은 해당 root의 `thread_unread_targets`를 원자적으로 추가합니다. 읽은 메시지에 나중에 추가된 mention은 unread cursor를 후퇴시키지 않습니다. 수정은 같은 트랜잭션에서 mention 관계를 교체합니다.

복귀 순서는 인증 → `GET /api/sync` 페이지 catch-up → `GET /api/conversations`에서 목록·unread·읽음 snapshot → 현재 대화 구독입니다. 구독 서버는 listener를 먼저 등록하고 global cursor watermark를 읽은 뒤 `(after_cursor, through_cursor]`의 해당 대화 변경을 재생합니다. 이 동안 도착한 더 새 이벤트는 replay 다음에 전달하고, `conversation.subscribed` ACK는 replay 경계를 표시합니다. 클라이언트는 `change_id`로 live/replay 중복을 안전하게 처리합니다. 영속 sync checkpoint는 REST catch-up이 완료된 watermark에 대해서만 전진시키므로 서로 다른 대화의 live 이벤트 순서가 달라도 누락되지 않습니다. 나간 대화의 구독은 즉시 닫습니다.

cursor 만료 시 410 snapshot 절차를 사용하고 완료 전 최신 상태로 표시하지 않습니다. 모바일이 5분 이상 백그라운드에 있다가 복귀할 때 인증·메시지 변경·삭제·읽음 snapshot을 동기화합니다. WebSocket은 commit 후 알림만 담당하고, 이벤트 유실은 DB 변경 로그에서 회복합니다. 메모리 연결 목록은 전달 최적화입니다.

## 5. 인증·TR-SEC

- 최초 owner 계정은 원격 HTTP 가입이 아니라 로컬 운영 런북에서 한 번만 생성합니다. 빈 DB에서만 성공하는 로컬 명령과 비노출 credential 입력을 사용하고, 이미 owner가 있으면 기존 계정·비밀번호를 덮어쓰지 않고 실패해야 합니다. secret은 로그에 쓰지 않고 password hash만 저장합니다. 초기 생성 성공·재실행 거부·원격 생성 거부·이후 초대 시작의 증거는 개발설계서 준비/인증 게이트에 기록합니다. 복구 절차는 외부 이메일 없이 로컬 운영으로 제한하며 상세 방법은 착수 전 확정합니다.
- 앱 인증은 tailnet 인증과 독립입니다. PRD 입력에 따라 이메일+비밀번호입니다. password hash는 검토된 Node 지원 해시 라이브러리를 사용하고, 착수 때 알고리즘·파라미터·라이브러리 버전을 보안 결정 기록에 고정합니다.
- 무작위 세션 token은 DB에 hash만 저장합니다. Cookie는 `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only입니다. 세션 수명은 30일 sliding이며 매 인증 요청에서 연장합니다. 로그아웃·revoke·비활성화 후 5초 안에 해당 WS를 닫습니다.
- 상태 변경 HTTP는 session-bound CSRF custom header와 정확한 Origin 검사를 통과해야 합니다. `GET /api/me`가 session-bound `csrf_token`을 반환하고, 변경 요청은 `X-CSRF-Token`으로 돌려줍니다. GET/HEAD 부작용은 금지합니다.
- WS handshake와 각 subscription에서 cookie session·Origin·membership을 확인합니다. 인증 token은 URL·localStorage·로그에 두지 않습니다.
- 대화 목록·이력·수정·삭제·읽음·sync·subscribe는 같은 서버 접근 검사를 사용합니다. 비참여자는 대화 ID의 존재를 추론할 수 없습니다.
- 메시지는 안전한 text node로 렌더합니다. 줄바꿈·코드 fence는 inert text/code block으로 표시하고, 자동 링크는 `https`·`http`만 허용합니다. raw HTML과 다른 위험 scheme은 실행하지 않습니다. 메시지 본문 최대 4,000 Unicode code point, WS frame 최대 64 KiB입니다. 초과 입력은 저장 전에 거부합니다. 첨부 업로드 body 상한은 §6-1 값입니다(이 라우트만 예외, 전역 64 KiB 유지).
- 로그인 실패는 계정과 source IP별 15분 동안 최대 5회 허용하고 이후 15분 차단합니다. 차단 만료 뒤 정상 자격 증명 로그인 성공 시 해당 제한 카운터를 초기화합니다. 계정 존재를 드러내지 않는 동일 오류 응답을 사용합니다. 제한값은 단일 사용자 운영을 위한 제안값이며 구현 전 보안 검토에서 확인합니다.
- sync change 보존은 30일 또는 100,000개 change row 중 먼저 도달하는 경계까지입니다. 경계 이전 cursor는 410입니다. 삭제 본문을 담은 change snapshot은 존재하지 않습니다.
- 로그·계측에서 본문·초안·이메일·IP·user agent·식별 ID·token·cookie·URL query·raw stack을 제외합니다.

| ID | 요구사항 | 수용 기준 제안 |
|---|---|---|
| TR-SEC-01 | 매 요청 세션·활성 membership 확인 | 합성 비참여자의 목록·이력·sync·쓰기·구독 결과 0 |
| TR-SEC-02 | 비밀번호/세션/초대 secret 원문 미저장 | DB·로그에서 표식 원문 0 |
| TR-SEC-03 | CSRF header + Origin 검증 | 잘못된 출처·token 요청의 변경 0 |
| TR-SEC-04 | revoke·비활성화 WS 전파 | 5초 내 close, 후속 HTTP 401 |
| TR-SEC-05 | 안전한 입력 표시 | 합성 script·위험 링크 실행 0 |
| TR-SEC-06 | HTTP/WS schema 및 크기 제한 | 잘못된 입력 저장 없이 거절; 4,000 code point·64 KiB 경계 검사 |
| TR-SEC-07 | tailnet 전용 노출 | 앱·봇 listener 모두 loopback만; 봇 listener 포트는 Serve 설정에 없음; public port·Funnel 없음; Tailscale Serve HTTPS endpoint 허용 |
| TR-SEC-08 | 사용자 본문 지속 캐시 금지 | Cache API/IndexedDB/localStorage에 본문·인증 응답 없음 |
| TR-SEC-09 | 개인정보 없는 계측 allowlist | 허용목록 외 필드 0; 계측 실패가 메시지 처리를 막지 않음 |
| TR-SEC-10 | 백업/복원 경계 | 별도 승인·격리 복원 대조; shared-infra 변경 없음 |

### 5-1. 보안 결정 R3.2 (Jarvis ★, 2026-11-07 — `docs/08-security/THREAT_MODEL.md` §6 해소)

위 본문과 충돌하면 이 절이 우선합니다. 값은 단일 사용자 개인 운영 기준이며 G1 Security 리뷰에서 재확인합니다.

| # | 주제 | 결정 | 근거·대상 테스트 |
|---|---|---|---|
| S1 | 로그인 제한 출처 | 앱은 Serve 뒤 루프백 요청만 받으므로 **source IP 제한을 쓰지 않습니다.** 계정별 15분 5회 실패 → 15분 차단(본문 유지) + **전역** 15분 20회 실패 → 15분 차단. 프록시·Tailscale 신원 헤더는 제한 키로도 신뢰하지 않습니다 | §6 #1, NC-06·NC-18, FR-AUTH-06 |
| S2 | 초대 수명·엔트로피 | 수명 **72시간**, token은 CSPRNG 32바이트(base64url), DB에는 SHA-256 hash만 | §6 #2, NC-16 |
| S3 | 초대 폐기 | `POST /api/invites/{id}/revoke` 추가(owner, `admin` 메타). 폐기·사용·만료 token 수락은 같은 오류로 거부 | §6 #3, FR-AUTH-01 |
| S4 | 자격 증명 복구 | 로컬 전용 명령 `apps/server/bin/reset-password.ts`(비노출 입력). 성공 시 대상 계정 **전 세션 revoke + WS 5초 내 close** | §6 #4, NC-21 |
| S5 | HTTP 캐시 | `/api/**` 모든 응답 `Cache-Control: no-store` | §6 #5, NC-02 |
| S6 | 보안 헤더(정본 이동) | 모든 HTML·API 응답: `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. 디자인 §6의 `Referrer-Policy`는 이 행을 인용. 첨부 오디오는 `default-src 'self'`(media-src 폴백)로 허용하며, 첨부 다운로드 응답에만 `Content-Security-Policy: sandbox; default-src 'none'`을 씁니다(§6-1, R3.3) | §6 #6, NC-13 |
| S7 | 세션 만료와 WS | 만료 시각 도달 시 열린 WS를 close(1008). WS 트래픽은 세션을 연장하지 않음(HTTP 인증 요청만 연장) | §6 #7, NC-10 |
| S8 | 세션 절대 상한 | sliding 30일 + **절대 90일** | §6 #9 |
| S9 | 비밀번호 해시·정책 | Node 26 내장 `crypto.argon2`(argon2id), memory 19456 KiB·passes 2·parallelism 1·tag 32바이트·salt 16바이트, PHC 문자열로 저장. 길이 12–128자(code point), 그 외 조합 규칙 없음 | §6 #13, NC-20 |
| S10 | owner 보호 | owner 자신 또는 마지막 owner 비활성화는 409, DB 무변경 | §6 #14, NC-19 |
| S11 | 401·계정 전환 시 checkpoint | 401 수신·로그아웃·다른 계정 로그인 시 sync checkpoint 삭제 | §6 #15, NC-14 |
| S12 | 복원 후 처리 | 복원 드릴 대상 DB에서 서비스 재개 전 전 세션·미사용 초대 무효화. 비활성화 목록 재적용 방식은 PRD ⚖️-3(백업) 결정 때 확정 | §6 #10, NC-23 |
| S13 | PG 노출(사실 확인) | shared-postgres는 `127.0.0.1:5432`에만 바인드(2026-11-07 `docker port` 확인), Serve 대상 아님 | §6 #11 |

TR-SEC 추가 행: **TR-SEC-11** 세션 cookie 속성(`HttpOnly`·`Secure`·`SameSite=Lax`·`Path=/`·host-only, 절대 90일) — 통합 테스트로 Set-Cookie 단언(NC-08). **TR-SEC-12** 로그인 제한(S1) — FR-AUTH-06.

TR-SEC 추가 행(R3.3, ADR-001): **TR-SEC-13** 봇 토큰 경계(§5-2) — 토큰 원문 DB·로그 0, 폐기·회전 후 옛 토큰 401·열린 봇 WS 5초 내 close, 봇 토큰으로 사람 `/api/**` 401·사람 쿠키로 봇 경로 401, `Origin`/`Cookie` 동봉 봇 요청 400, 봇 listener는 Serve에서 닿지 않음(FR-BOT-02). **TR-SEC-14** 첨부 응답 헤더·형식 판정(§6-1) — 매직 바이트 판정 불일치 415·상한 초과 413·저장 0, 다운로드 응답에 `no-store`·`nosniff`·`sandbox` CSP, 비참여자 404(FR-OPS-05). **TR-SEC-15** push payload 무본문·endpoint 허용목록(§6-2) — payload 허용 키 밖 필드 0(본문·대화 이름·작성자 이름 0), 허용목록 밖·비 https endpoint 등록 거부, 404/410 구독 삭제(FR-CLIENT-05). 따라서 TR-SEC 집합은 TR-SEC-01–15입니다.

위 표는 설계 제안이며 보안 감사나 구현 검증 결과가 아닙니다. 코드·DB·`.env`·인증정보·shared-infra에 접근하지 않았습니다.

### 5-2. 봇 인증·권한 (R3.3, ADR-001 §3-a–e)

봇 리스너와 봇 토큰 요청에 한해, 위 §3·§4·§5 본문·§5-1과 충돌하면 이 절이 우선합니다(사람 요청·메인 리스너 규칙은 바꾸지 않습니다). 수치는 단일 사용자 운영 **제안값**이며 미측정입니다. 구현 전 Security 리뷰에서 확인합니다.

1. **봇 계정**: `users.kind='bot'`, `password_hash` NULL, workspace role `member`. 생성·비활성화·토큰 발급/회전/폐기는 로컬 명령 `apps/server/bin/bot-admin.ts`(비노출 출력, 원격 경로 없음)만 사용합니다. 로그인 서비스는 kind=bot을 일반 실패와 같은 오류로 거부하고 `sessions` 행을 만들지 않습니다.
2. **토큰**: CSPRNG 32바이트 base64url에 접두사 `omsb_`(로그 마스킹·유출 스캔용). DB에는 SHA-256만 저장합니다. 원문은 발급 시 1회 출력합니다. 회전은 새 토큰 발급 → 어댑터 교체 → 옛 토큰 폐기 순서이며 봇당 미폐기 토큰은 2개까지입니다. 폐기·봇 비활성화 시 열린 봇 WS를 5초 안에 close합니다(TR-SEC-04와 같은 sweep). 만료 시각은 두지 않고(ADR-001 D-7 ★, 로컬 전용·회전 CLI로 관리) `last_used_at`을 기록합니다.
3. **봇 리스너**: 별도 Fastify 인스턴스가 `127.0.0.1:<BOT_PORT>`에만 바인드합니다(bind 가드 재사용). Tailscale Serve 설정에 넣지 않습니다. 등록 라우트는 `/api/bot/v1/**`뿐이며 Host 허용목록은 `127.0.0.1:<BOT_PORT>`·`localhost:<BOT_PORT>`입니다. 메인 리스너는 `Authorization` 헤더를 인증에 쓰지 않습니다.
4. **CSRF·Origin 예외 범위**: 봇 리스너에서만 CSRF 헤더·Origin 일치 검사를 적용하지 않습니다. 근거: 쿠키를 인증에 쓰지 않으므로 브라우저 자동 자격 증명 첨부가 없습니다. 대신 **`Origin` 또는 `Cookie` 헤더가 있는 요청은 400으로 거부**(브라우저발 요청 차단)합니다. 메인 리스너의 기존 규칙(security.ts 전역 훅, accountGuard CSRF)은 바꾸지 않습니다.
5. **멤버십 상한**: 봇은 ① 봇 생성 시 CLI가 만드는 owner와의 DM ② owner가 웹에서 명시적으로 봇을 추가한 공개 채널(P1 FR FR-BOT-08)에만 참여합니다. 수치 상한은 두지 않습니다. 채널에서 봇이 읽는 메시지는 참여 시점 `joined_seq` 이후 메시지이며, 참여 전에 시작된 스레드는 통째로 제외합니다(P1 FR FR-BOT-09, 봇 행위자에만 적용). 봇 토큰용 `POST /api/dms`·채널 참여·멤버 추가·멤버 목록 조회 라우트는 등록하지 않습니다. 접근 검사는 기존 `assertAccess` 단일 경계를 그대로 씁니다.
6. **봇 라우트(최소)**: `GET /api/bot/v1/me`(봇 id, owner_user_id, 참여 대화 id 목록; P1 FR FR-BOT-09에서 `conversations[{id,kind}]`·`display_name` 추가, `conversation_ids`는 호환 유지), `GET /api/bot/v1/conversations/{id}/messages`, `GET /api/bot/v1/messages/{root_id}/replies`, `POST /api/bot/v1/conversations/{id}/messages`, `PATCH /api/bot/v1/messages/{id}`, `GET /api/bot/v1/sync`, `GET /api/bot/v1/sync/snapshot`(사람 `GET /api/sync/snapshot`과 같은 계약·`assertAccess`), `POST /api/bot/v1/attachments`, `GET /api/bot/v1/attachments/{id}`, `PUT /api/bot/v1/read-state`, WS `/api/bot/v1/ws`. 요청·응답 스키마는 사람 라우트와 같은 shared zod 스키마입니다. **최초 연결·cursor 만료(410) 복구**는 사람 기기와 같은 절차(§3 snapshot·§4 복귀 순서)를 봇 라우트로 수행합니다: `GET /api/bot/v1/me`로 참여 대화 확인 → 대화별 `GET /api/bot/v1/sync/snapshot`으로 `snapshot_cursor` 확보 → 그 cursor부터 `GET /api/bot/v1/sync` 페이지 catch-up → WS 구독. 복구 중 받은 지시는 ADR-001 D-7의 밀린 메시지 처리 상한(15분)을 그대로 적용합니다.
7. **rate limit(봇 토큰별, 메모리)**: 메시지 생성 30건/분, 수정 60건/분, 첨부 업로드 10건/분·100 MiB/일. 초과 시 429, 저장 0.
8. **작성자 종류 노출**: 모든 메시지 projection에 `author_kind`를 싣습니다. 어댑터의 owner 판정은 `GET /api/bot/v1/me`의 `owner_user_id`와 서버가 채운 `author_id` 비교로 합니다(본문 내용으로 판정 금지).

### 5-3. 기기 세션 라벨·원격 로그아웃 (R3.6, ADR-002 §3 1c, P1 FR-AUTH-04 — 계약 확정·구현 대기)

사람 세션에 한해 §3 `GET /api/sessions`·`DELETE /api/sessions/{id}`의 세부입니다. ★는 이 레인의 제안값입니다(미측정).

1. **라벨 생성:** 로그인 성공으로 세션 행을 만들 때 한 번만, 서버가 요청 `User-Agent`에서 `「{기기 종류} · {브라우저}」` 형식의 거친 라벨을 만들어 `sessions.device_label`에 저장합니다. 원문 User-Agent·IP·버전 번호·OS 버전은 저장·로그·응답 어디에도 남기지 않습니다(§5 로그 제외 목록 유지). 라벨은 이후 갱신하지 않습니다. 길이 ★1–64자(code point), 넘거나 규칙에 없으면 NULL. 웹은 NULL을 「알 수 없는 기기」로 그립니다(COPY_GAPS G-65).
2. **★ 생성 규칙(표 밖 값은 만들지 않음):** 기기 종류와 브라우저를 각각 아래 표에서 처음 맞는 행으로 고르고, 둘 중 하나라도 정하지 못하면 라벨 전체를 NULL로 둡니다(부분 라벨 없음).

| 축 | 판정(UA 부분 문자열, 위에서부터 첫 일치) | 라벨 값 |
|---|---|---|
| 기기 종류 | `iPhone` | `iPhone` |
| 기기 종류 | `iPad` | `iPad` |
| 기기 종류 | `Android` | `Android` |
| 기기 종류 | `Macintosh` | `Mac` |
| 기기 종류 | `Windows` | `Windows` |
| 기기 종류 | `Linux` | `Linux` |
| 브라우저 | `Edg/` | `Edge` |
| 브라우저 | `Firefox/` 또는 `FxiOS/` | `Firefox` |
| 브라우저 | `Chrome/` 또는 `CriOS/` | `Chrome` |
| 브라우저 | `Safari/` (위 행에 걸리지 않은 경우) | `Safari` |

   - 예: iPhone Safari → 「iPhone · Safari」, Mac Chrome → 「Mac · Chrome」. iPad 데스크톱 모드처럼 UA가 `Macintosh`를 보내면 「Mac」으로 보일 수 있습니다(거친 라벨의 한계, 수용).
   - 상수(제안 이름) `SESSION_DEVICE_LABEL_MAX = 64`는 `packages/shared` 인증 모듈에 둡니다.
3. **목록:** 본인(`user_id` = 요청 계정)의 `revoked_at IS NULL AND expires_at > now()` 세션만, 항목은 `id`·`device_label`·`created_at`·`last_seen_at`·`current`입니다. 현재 응답(`{id,created_at,last_seen_at,expires_at,current}` — `apps/server/src/modules/auth/routes.ts:52-63`, 스키마 `packages/shared/src/auth.ts:25-35`)에서 `device_label`을 더하고 `expires_at`은 빼는 변경입니다(웹 화면이 쓰지 않음 — UI_STATES §2-14. 2026-11-13 `git grep` 기준 `apps/web/src`·서버 테스트에 세션 응답 `expires_at` 소비처 0).
4. **원격 로그아웃 판정 순서:** 인증·CSRF·Origin(실패 401/403) → 경로 `id` UUID 형식(아니면 400) → `id` = 현재 요청 세션이면 400 → 본인 세션 행 조회(없거나 남의 세션이면 404, 같은 응답·같은 처리 경로) → 이미 폐기·만료면 204(DB 무변경) → 폐기 204.
5. **폐기 동작:** 로그아웃과 같은 저장소 연산을 재사용합니다 — 현재 `store.revokeSession`이 한 문장에서 `revoked_at`을 쓰고 그 세션의 `push_subscriptions` 행을 지웁니다(`apps/server/src/modules/auth/repo.ts:91-97`). `push_subscriptions.session_id`의 FK `ON DELETE CASCADE`(`apps/server/migrations/0004_push.sql:18`)는 세션 행 **삭제** 때만 동작하고 폐기는 행을 지우지 않으므로, ★ push 구독 삭제는 **서비스(저장소) 삭제**로 정합니다(CASCADE 의존 아님). 커밋 후 `sessionRevoked([id])` 이벤트를 내면 WS 허브가 그 세션 연결을 즉시 1008로 닫고(`apps/server/src/modules/realtime/hub.ts:276-279`), 이벤트를 놓쳐도 세션 sweep(4초, `hub.ts:71,113-114,144-154`)이 닫아 5초 상한(TR-SEC-04)을 지킵니다. 그 기기의 다음 HTTP 요청은 401입니다.
6. **로그:** 원격 로그아웃 성공·실패는 ops 로거 허용 필드(라우트 템플릿·상태 코드)만 남기고 세션 ID·라벨은 남기지 않습니다(B6).

## 6. Tailscale Serve와 PWA

Tailscale Serve HTTPS는 tailnet에서 로컬 reverse proxy로 제안합니다. 앱 백엔드 listener는 `127.0.0.1:<port>`만 사용하며, tailnet HTTPS 접점은 Tailscale Serve가 제공합니다. Funnel, router port forwarding, LAN bind, `0.0.0.0` listener는 금지합니다. Serve hostname은 비밀이 아니므로 앱 인증을 유지하고 Mac sleep/offline은 명시적으로 표시합니다. DB port는 Serve하지 않습니다.

PWA manifest는 승인된 배포 이름, `start_url=/`, `scope=/`, `display=standalone`을 사용합니다. 아이콘 세트와 관련 크기·purpose·apple touch icon은 디자인 레퍼런스 §9-2 정본을 따릅니다. service worker는 해시된 app shell 정적 파일만 캐시하고 `/api/**`, 메시지·읽음·인증·초대 응답과 WS를 우회합니다. 첨부(`/api/attachments/**`)도 우회합니다. push 이벤트 핸들러는 알림 표시만 하고 본문을 저장하지 않습니다. 본문은 Cache API·IndexedDB·localStorage에 저장하지 않고 화면 메모리에서만 일시 보유합니다. 지속 발신 큐는 없고 server ACK 전 성공 표시도 없습니다. 예외로 오프라인 때문에 보내지 못한 메시지는 같은 화면 세션 안에서 `online` 복귀 때 같은 `client_message_id`로 한 번 자동 재전송합니다(화면 메모리 한정, 2026-11-17 결정, UI_STATES §2-5). 로그아웃 시 화면 데이터를 비웁니다.

반응형 구간·레이아웃 폭·IME·키보드 동작·상태 문구는 디자인 레퍼런스의 브레이크포인트·레이아웃·IME 규칙을 정본으로 따릅니다. offline messaging은 약속하지 않습니다. Web Push는 §6-2 범위로 제공합니다. iOS Safari별 설치·cookie·WS 동작은 QA 확인 대상입니다.

### 6-1. 첨부 (R3.3, ADR-001 §3-g, PRD FR-OPS-05)

- 허용 형식: `audio/mpeg`(mp3), `image/png`, `image/jpeg`, `image/webp`. **서버가 매직 바이트로 판정**하고 선언 `Content-Type`·파일명과 다르면 415입니다. SVG·HTML·PDF 등은 FR-OPS-09(P1) 전까지 거부합니다.
- 상한: 파일당 10 MiB(10,485,760바이트), 메시지당 4개. 업로드 라우트만 body 상한 예외입니다. 초과 시 413, 저장 0.
- 저장: PostgreSQL `attachment_blobs`(ADR-001 D-4 ★ — 단일 원장·백업/복원 일관성). 대안(로컬 디스크 디렉터리)은 ADR-001 §3-g.
- 결속: 업로드 → `attachment_id`(미결속, 1시간 내 메시지에 결속 안 되면 삭제) → 메시지 생성 시 `attachment_ids`로 결속합니다. 결속 때 요청 배열에서의 위치를 `bind_order`에 기록하고, 첨부 projection은 `bind_order NULLS LAST, created_at, id`로 정렬합니다(R3.7 — 0007 이전 결속 행은 NULL이라 기존 표시 순서 유지). 잠금 순서(ID 정렬 `FOR UPDATE`)와 결속 검증은 그대로입니다.
- 보존: 오디오 30일, 이미지 90일(제안) 경과 시 바이트를 삭제하고 메타데이터는 「만료된 첨부」 자리표시자로 유지합니다. 메시지 삭제 시 즉시 바이트를 삭제합니다.
- 다운로드 응답: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition: inline`(허용 미디어만), **HTTP Range(206) 지원**(iOS 오디오 재생 — 실기 QA 확인 필요).
- 권한: `access: attachment` 메타 → 첨부의 `conversation_id`로 `assertAccess(read)`. 비참여자 404.

### 6-1-1. 문서 첨부 (R3.5, ADR-002 §4, PRD FR-OPS-09 — 계약 확정·구현 대기 1b)

§6-1의 경계(허용목록·내용 판정·`attachment_blobs` 저장·`access: attachment`·응답 헤더)를 그대로 재사용하고 **문서 형식만** 넓힙니다. 문서와 충돌하는 §6-1 문장(PDF 거부, `inline`, 10 MiB)은 이 소절이 문서 형식에 한해 우선합니다. ADR-002 §4-3 결정 5개(매크로 문서 받음·구형 Office 받음·양방향·25 MiB·90일, 영환님 2026-11-10)는 바꾸지 않습니다. ★는 이 레인의 제안값입니다(미측정).

**(1) 허용 형식과 서버 판정**

| 형식 | 저장 확장자 | 저장 MIME | 판정 규칙(모두 만족) |
|---|---|---|---|
| PDF | `.pdf` | `application/pdf` | 오프셋 0이 `%PDF-` + 파일 끝 65,557바이트 안에 ZIP EOCD 서명 `PK\x05\x06`이 없음(있으면 PDF+ZIP 이중 해석으로 보고 415) |
| Word (OOXML) | `.docx` / 매크로 시 `.docm` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `application/vnd.ms-word.document.macroEnabled.12` | ZIP 컨테이너(아래) + `[Content_Types].xml` 엔트리 + `word/document.xml` 엔트리 |
| Excel (OOXML) | `.xlsx` / 매크로 시 `.xlsm` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` / `application/vnd.ms-excel.sheet.macroEnabled.12` | ZIP 컨테이너 + `[Content_Types].xml` + `xl/workbook.xml` |
| PowerPoint (OOXML) | `.pptx` / 매크로 시 `.pptm` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` / `application/vnd.ms-powerpoint.presentation.macroEnabled.12` | ZIP 컨테이너 + `[Content_Types].xml` + `ppt/presentation.xml` |
| 한글 (HWPX) | `.hwpx` | `application/hwp+zip` | ZIP 컨테이너 + 첫 엔트리 `mimetype`(저장 방식 0=무압축)의 내용이 정확히 `application/hwp+zip` + `Contents/content.hpf` 엔트리 |
| 한글 (HWP 5.x) | `.hwp` | ★`application/x-hwp` | OLE 컨테이너(아래) + 루트 `FileHeader` 스트림 첫 17바이트 `HWP Document File` + `DocInfo` 스트림 + `BodyText` 저장소 |
| Word 97–2003 | `.doc` | `application/msword` | OLE 컨테이너 + 루트 `WordDocument` 스트림 |
| Excel 97–2003 | `.xls` | `application/vnd.ms-excel` | OLE 컨테이너 + 루트 `Workbook` 스트림(`Book` = Excel 5/95 이하는 415) |
| PowerPoint 97–2003 | `.ppt` | `application/vnd.ms-powerpoint` | OLE 컨테이너 + 루트 `PowerPoint Document` 스트림 |
| 텍스트 (R3.6) | `.txt` | `text/plain`(응답 `text/plain; charset=utf-8`) | 텍스트 판정(아래 「텍스트 계열」) + 확장자 `.txt` |
| 마크다운 (R3.6) | `.md` | `text/markdown`(응답 `text/markdown; charset=utf-8`) | 텍스트 판정 + 확장자 `.md` |
| CSV (R3.6) | `.csv` | `text/csv`(응답 `text/csv; charset=utf-8`) | 텍스트 판정 + 확장자 `.csv` |

- **읽는 범위(불변식):** ZIP은 EOCD·중앙 디렉터리 **목록만**, OLE는 헤더·FAT/DIFAT·디렉터리 엔트리 **목록만** 읽습니다. 예외는 두 곳의 고정 길이 읽기뿐입니다: HWPX `mimetype`(무압축 저장 엔트리 19바이트), HWP `FileHeader` 첫 32바이트(미니 스트림 경유 가능). **압축 해제·XML 파싱·형식 변환·미리보기·썸네일·텍스트 추출은 서버에서 0입니다**(ADR-002 §5-7).
- **ZIP 컨테이너 규칙:** 오프셋 0이 로컬 헤더 `PK\x03\x04`. EOCD(`PK\x05\x06`)는 파일 끝에서 22+주석 길이 위치에 정확히 하나이고 그 뒤 잔여 바이트 0. `cd_offset + cd_size = EOCD 오프셋`. 분할(다중 디스크)·ZIP64(`PK\x06\x06`/`PK\x06\x07`)·암호화 플래그(general purpose bit 0) 엔트리는 415. 엔트리 이름 중복·NUL 포함은 415.
- **OLE 컨테이너 규칙:** 오프셋 0이 `D0 CF 11 E0 A1 B1 1A E1`, 바이트 순서 `FE FF`, 메이저 버전 3(섹터 512B) 또는 4(섹터 4,096B)만. 섹터 번호는 파일 섹터 수 미만이어야 하고 체인 순환은 방문 표식으로 즉시 415. 루트에 `EncryptionInfo`·`EncryptedPackage`가 있으면(암호 걸린 OOXML) 415.
- **단일 일치 규칙(폴리글랏 차단):** 모든 이진 판정기(§6-1 미디어 4종 + 위 문서 9종)를 돌려 **정확히 하나**만 일치해야 저장합니다(텍스트 판정은 아래처럼 이 집합 밖의 마지막 단계). 0개 또는 2개 이상(예: ZIP 안에 `word/document.xml`과 `xl/workbook.xml` 동시 존재)은 415입니다. ZIP 판정은 오프셋 0 `PK\x03\x04`를 요구하므로 `%PDF-`로 시작하고 끝에 ZIP을 붙인 파일은 PDF 행의 EOCD 서명 검사로 415가 됩니다.
- **텍스트 계열(R3.6, ADR-002 §4-3 Q12 ★):** 이진 판정기 13종이 **모두 0개 일치**일 때만 텍스트 판정을 돌립니다(이진 판정기가 1개라도 일치하면 텍스트로 보지 않고, 2개 이상이면 위 규칙대로 415). 조건(모두 만족): ① 버퍼 전체가 유효 UTF-8(선두 BOM `EF BB BF` 허용, 잘린 다중 바이트·과장 인코딩·서로게이트 코드 포인트는 실패) ② NUL(0x00) 바이트 0개 ③ 원 파일명 확장자가 `.txt`·`.md`·`.csv` 중 하나 — 저장 MIME은 이 확장자로 정합니다(내용으로 셋을 구분하지 않음). 확장자가 셋 밖이면(예 `.html`·`.svg`·`.js`) `extension_mismatch`가 아니라 `unsupported_media_type` 415입니다(허용 형식이 아님). `has_macros = false` 고정, 상한은 문서와 같은 25 MiB(`ATTACHMENT_DOC_MAX_BYTES`), 보존은 문서와 같은 90일(`document`). 내용이 HTML·SVG·스크립트여도 다운로드는 항상 아래 (6)의 `attachment` + `nosniff` + sandbox CSP라 브라우저 렌더는 0입니다(THREAT_MODEL TM-ATT-12).
- **선언 값:** 업로드 `Content-Type`은 판정 결과 MIME 또는 `application/octet-stream`일 때만 통과(그 밖은 415). 텍스트 계열은 매개변수(`; charset=…`)를 무시하고 미디어 타입만 비교합니다. 브라우저마다 문서 MIME 선언이 달라 미디어(§6-1, 선언=판정 일치 필수)보다 완화하되, 저장·응답 MIME은 항상 판정 결과입니다.
- **확장자-형식 일치(415):** 원 파일명의 마지막 확장자(대소문자 무시)가 판정 형식의 허용 확장자여야 합니다. 매크로가 감지된 OOXML은 `.docm/.xlsm/.pptm`만 허용(`.docx` 등으로 오면 415 — ADR-002 §4-3-1). 매크로가 없는 OOXML은 `x`·`m` 두 확장자 모두 허용하고 원래 확장자를 유지합니다. 그 밖의 형식은 표의 확장자 1개만(텍스트 계열도 행마다 1개).

**(2) 판정기 자원 상한(★, 상수는 `packages/shared` 문서 첨부 모듈)**

| 상수(제안 이름) | ★값 | 근거 |
|---|---|---|
| `DOC_ZIP_MAX_ENTRIES` | 5,000 | 실사용 OOXML·HWPX는 수십–수백 엔트리, 슬라이드 수백 장 pptx도 수천 미만. EOCD 선언 엔트리 수가 넘으면 중앙 디렉터리를 읽기 전에 415 |
| `DOC_ZIP_MAX_CD_BYTES` | 2 MiB (2,097,152) | 엔트리 5,000 × (고정 46B + 이름 ≤ 300B) 상한 근사. 선언 `cd_size` 초과 시 415 |
| `DOC_ZIP_MAX_NAME_BYTES` | 1,024 | ZIP 형식 상한 65,535B를 판정용으로 축소. 초과 엔트리 415 |
| `DOC_ZIP_EOCD_SCAN_BYTES` | 65,557 | EOCD 22B + 주석 최대 65,535B(ZIP 형식 상한). 그 밖은 탐색하지 않음 |
| `DOC_OLE_MAX_DIR_SECTORS` | 1,024 | 섹터 512B 기준 디렉터리 엔트리 4,096개. 실사용 문서는 수십–수백 엔트리 |
| `DOC_OLE_MAX_DIR_ENTRIES` | 4,096 | 위와 같음(섹터 4,096B 버전 4에도 엔트리 수로 같은 상한) |
| `DOC_OLE_MAX_CHAIN_STEPS` | 파일 섹터 수(25 MiB/512B = 51,200) | FAT·DIFAT·미니 FAT 체인 순회 총 단계. 순환·자기 참조는 방문 표식으로 즉시 415 |
| `DOC_SNIFF_DEADLINE_MS` | 1,000 | 위 단계 상한이 1차 통제(결정적·테스트 가능). 벽시계 상한은 보조 안전판이며 초과 시 415 + ops 로그 `reason=sniff_deadline`(본문·파일명 미기록) |

- 판정기는 업로드 body 버퍼(최대 25 MiB) 위에서 동기로 돌고 추가 할당은 중앙 디렉터리·디렉터리 섹터 크기 이하입니다.
- ★ 사람 계정 동시 업로드 2건(메모리, 초과 429): 25 MiB 버퍼가 동시에 쌓이는 것을 막습니다. 봇은 §5-2 (7) rate limit을 그대로 씁니다.

**(3) 매크로 감지 → `has_macros`**

- OOXML: 엔트리 이름이 `vbaProject.bin`으로 끝나는 것(대소문자 무시, 예 `word/vbaProject.bin`) 또는 `xl/macrosheets/` 아래 엔트리 → `has_macros = true`.
- OLE(.doc/.xls/.ppt/.hwp): 디렉터리 어디든 `Macros`·`_VBA_PROJECT_CUR`·`VBA` 저장소 → `true`. ★ HWP는 `Scripts` 저장소(스크립트 매크로)도 `true`, HWPX는 `Scripts/` 아래 엔트리도 `true`. 주의(확인 필요): 일반 HWP 저장본에도 `Scripts` 저장소(`DefaultJScript`·`JScriptVersion`)가 기본으로 들어 있을 수 있어, 그렇다면 사실상 「`.hwp`는 항상 `true`」(아래 `.xls`·`.ppt`와 같은 거짓 양성)가 됩니다. 1b S1이 매크로 없는 표본으로 확인한 뒤 스트림 크기 기준 등으로 좁힐지 정합니다.
- ★ **목록으로 판정할 수 없는 경우 보수 표시:** `.xls`(Excel 4.0 매크로 시트는 `Workbook` 스트림 안)와 `.ppt`(VBA 저장소가 `PowerPoint Document` 스트림 안에 압축 저장)는 목록만으로 매크로 부재를 증명할 수 없으므로 항상 `has_macros = true`로 저장합니다(거짓 양성 수용).
- PDF는 `has_macros = false`(PDF 능동 콘텐츠는 파싱하지 않음 — 다운로드 전용으로만 완화, THREAT_MODEL TM-ATT-07). 텍스트 계열 3종도 `false`.
- 응답 projection에 `has_macros`를 싣고 웹은 첨부 행에 텍스트 표지를 표시합니다(문구는 UI 명세·COPY_GAPS 소관).

**(4) 상한**

| 항목 | 값 | 비고 |
|---|---|---|
| 문서 파일당 | **25 MiB = 26,214,400바이트** (상수 `ATTACHMENT_DOC_MAX_BYTES`) | ADR-002 §4-3-4. 텍스트 계열 3종도 같은 상한(R3.6) |
| 이미지·음성 파일당 | 10 MiB = 10,485,760바이트 (기존 `ATTACHMENT_MAX_BYTES`) | 유지. 판정이 미디어인데 10 MiB 초과면 413 |
| 메시지당 개수 | 4개(기존 `ATTACHMENTS_PER_MESSAGE_MAX`, 문서·미디어 합산) | 유지 |
| 업로드 라우트 body 상한 | 26,214,400 | 사람 `POST /api/attachments`, 봇 `POST /api/bot/v1/attachments` 모두 같은 상수. 전역 64 KiB는 유지 |
| 봇 리스너 | 업로드 라우트만 26,214,400, 그 밖 64 KiB 유지 | 어댑터 업로드·다운로드 상한도 같은 값 |
| 봇 업로드 rate | 10건/분·100 MiB/일 유지(§5-2 (7)) | 최대 크기 문서 하루 4개. 실사용 후 조정은 확인 필요 |

- 순서: body 상한(413, 저장 0) → 0바이트(400) → 판정(415 `unsupported_media_type`·`encrypted_document`; 이진 판정기 0개 일치면 텍스트 판정 — 확장자로 MIME 확정) → 종류별 상한(미디어 10 MiB 초과 413) → 확장자 일치(415 `macro_extension_mismatch`·`extension_mismatch`) → 저장.

**(5) 원 파일명 저장·정규화**

- 현재 `attachments`에는 파일명 컬럼이 없습니다(`apps/server/migrations/0003_attachments.sql:5-27`, 마지막 번호 `0004_push.sql`). 마이그레이션 ★`0005_attachment_documents.sql`: `attachments.mime` CHECK에 위 문서 9종 + 텍스트 3종(R3.6) MIME 추가, `byte_size` CHECK를 `BETWEEN 1 AND 26214400`으로(미디어 10 MiB는 서비스 검사), 컬럼 `filename text NULL`(기존 미디어 행은 NULL), `has_macros boolean NOT NULL DEFAULT false` 추가, `CHECK ((mime IN (<문서 9종·텍스트 3종>)) = (filename IS NOT NULL))`, `CHECK (filename IS NULL OR (char_length(filename) BETWEEN 1 AND 200 AND octet_length(filename) <= 255))`.
- 전달: ★ 요청 헤더 `X-Attachment-Filename`에 UTF-8 퍼센트 인코딩 값(인코딩 후 ≤ 1,024바이트, 초과·잘못된 UTF-8은 400). 쿼리 문자열은 프록시·이력에 남을 수 있어 쓰지 않습니다. 문서·텍스트 계열인데 헤더가 없으면 400(텍스트는 확장자로 형식을 정하므로 헤더가 필수입니다).
- ★ 정규화(서버, 순서대로): ① 퍼센트 디코드 → 유효 UTF-8 ② NFC ③ 마지막 `/`·`\` 뒤만 남김(basename) ④ C0(U+0000–001F)·DEL·C1(U+0080–009F)·양방향 제어(U+061C, U+200E–200F, U+202A–202E, U+2066–2069) 제거 ⑤ 앞뒤 공백·점 제거 ⑥ 확장자 분리 후 확장자는 판정 형식의 소문자 정규형으로 교체(예 `보고서.PDF` → `보고서.pdf`) ⑦ 줄기(stem)를 code point 경계에서 잘라 전체 ≤ 200 code point·≤ 255 UTF-8 바이트 ⑧ 줄기가 비면 `document`.
- 파일명은 첨부 projection(`attachments[]`의 `filename`)에만 싣고 로그·계측·push payload에는 넣지 않습니다(B6, TR-SEC-15). 로그 카나리아(`check:log-leak`)에 합성 파일명을 추가합니다.

**(6) 다운로드 응답(문서·텍스트 계열)**

- `Content-Disposition: attachment; filename="<ASCII 대체>"; filename*=UTF-8''<퍼센트 인코딩>`(RFC 6266 §4.3 순서, RFC 5987 `attr-char` 밖은 모두 `%XX`). ASCII 대체는 정규화 이름에서 출력 가능 ASCII 밖 문자와 `"` `\` `%` `;`를 `_`로 바꾼 값입니다. 헤더 값에 원문 문자열을 그대로 넣지 않습니다(CR·LF 주입 불가).
- 헤더 파일명 길이: 저장 시 NFD로 바꿔 255바이트에서 자르는 클라이언트(iOS 「파일」)에서 한글 음절이 자모로 깨지지 않도록, `NFD(이름)`의 UTF-8이 `ATTACHMENT_FILENAME_MAX_BYTES`(255)를 넘으면 줄기를 자소(한글 음절·결합 문자·이모지 시퀀스) 경계에서 줄여 `NFD(줄기 + "." + 확장자)` ≤ 255바이트로 맞춥니다. 확장자는 항상 보존, ASCII 대체도 같은 줄인 이름에서 만듭니다. 저장 이름(DB·projection)은 그대로입니다(`fitDownloadFilename`, `apps/server/src/modules/attachments/filename.ts`).
- `Content-Type`은 저장된 판정 MIME(텍스트 계열은 `; charset=utf-8`을 붙임 — 봇 경로·미디어. 사람 경로의 문서·텍스트는 아래 octet-stream), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` 유지. **문서·텍스트 계열은 `inline` 금지**(현재 다운로드는 형식과 무관하게 `inline` 고정 — `apps/server/src/modules/attachments/routes.ts:99`. 형식 분기 누락을 테스트로 고정). Range(206)는 §6-1 그대로.
- 사람 다운로드(`GET·HEAD /api/attachments/:id`)의 문서·텍스트는 `Content-Type: application/octet-stream`으로 보냅니다(파일명은 위 `Content-Disposition` 그대로, 본래 MIME은 projection `mime`에 남음) — iOS 홈 화면 앱은 앱 범위 안 PDF·텍스트를 창 안에 열어 돌아올 수 없게 되고, octet-stream이면 다운로드 시트로 받습니다(실기 r3, 2026-11-14). 봇 경로(`/api/bot/v1/attachments/:id`)는 위 판정 MIME 그대로입니다.
- SW 우회(`/api/attachments/**`)·지속 캐시 0 유지(FR-CLIENT-04).
- 웹의 「받기」는 `<a href="/api/attachments/{id}" download>` 일반 링크이며 JS fetch·blob을 쓰지 않습니다(UI-D5, UI_STATES §2-13). 저장 여부는 위 `attachment` 응답이 정합니다.

**(7) 보존·삭제·백업**

- 문서 보존 **90일**(`ATTACHMENT_RETENTION_DAYS`에 `document: 90` 추가): 경과 시 바이트 삭제, 메타는 「만료된 첨부」 자리표시자(파일명·크기 표시는 UI 명세가 정함). 메시지 삭제 시 같은 트랜잭션에서 즉시 바이트 삭제(§6-1 규칙 재사용). 미결속 1시간 삭제 유지.
- 백업·복원 드릴(FR-OPS-02) 측정 항목(1b 레인, 격리 테스트 DB·합성 데이터만): ① 합성 문서 0 / 0.5 / 1 GiB 적재 시 `pg_dump -Fc` 시간·덤프 크기 ② `pg_restore` 시간 ③ 드릴 대조 항목에 첨부 메타 수·`attachment_blobs` 바이트 합·sha256 표본 일치 추가 ④ 결과는 기록만(합격 임계는 확인 필요). 현재 드릴 합성 시드는 첨부 행이 0입니다(`tools/restore-drill/sql.ts:31-59`).

**(8) 방향과 Hermes 경계**

- **봇 → 사람:** Hermes가 어댑터 `send_document(chat_id, file_path, caption, file_name, reply_to, metadata)`를 호출하면 어댑터는 현재 `send_document`가 텍스트 대체뿐이므로(`integrations/hermes-plugin/ohmyslack/adapter.py:759-761`) 기존 음성·이미지 업로드 경로(`O_NOFOLLOW`·일반 파일 읽기 `adapter.py:80-117`, 상한만 25 MiB로; 1B–25 MiB 읽기 → `POST /api/bot/v1/attachments` + `X-Attachment-Filename`(= `file_name` 또는 `file_path` basename) → 메시지 생성 `attachment_ids`)를 씁니다. 415·413·429는 텍스트 대체 + 실패를 Hermes 결과(`success=False` 또는 `warnings`)로 올립니다(1a와 같은 원칙). 본문은 caption, 없으면 정규화 파일명(TRD §2 본문 필수 규칙).
- **사람 → 봇:** 웹 업로드 → 메시지 결속 → 어댑터가 owner 작성 메시지(TM-BOT-04 allowlist)의 문서 첨부만 `GET /api/bot/v1/attachments/{id}`로 받습니다(상한 25 MiB, 만료·삭제 첨부는 건너뜀) → Hermes 문서 캐시에 저장 → 세션에는 파일 경로 안내만 전달합니다.
- **어댑터 문서 캐시 경계:** 현재 어댑터 인바운드는 이미지만 넘깁니다(`adapter.py:545-569`). Hermes 문서 캐시 디렉터리(0700, `~/.hermes/hermes-agent/gateway/platforms/base.py:567-598`·`:724`)만 사용하고 어댑터 자체 디렉터리를 만들지 않습니다. 파일 이름은 Hermes가 붙이는 무작위 접두사 + 정규화 파일명이며(`base.py:1417-1430`; 이 함수는 크기 검사를 하지 않으므로 어댑터 상한이 유일한 크기 통제) 서버가 정한 확장자를 씁니다. 삭제 시점은 Hermes 미디어 캐시 정리(약 24시간 + 정리 주기, `~/.hermes/hermes-agent/agent/provider_media.py:25`)이고, ★ 어댑터는 같은 메시지가 삭제(`message.deleted`)되면 해당 캐시 파일을 즉시 지웁니다. 캐시 파일은 서버 90일 보존보다 짧아야 합니다.
- **Hermes 측 처리:** 받은 문서는 텍스트 추출만 하고 Office 앱 실행·매크로 실행·형식 변환을 하지 않습니다. 추출 입력 상한 = 25 MiB. HWP/HWPX 추출기는 현재 없음(Hermes 코드 검색 기준, 확인 필요 — 경로 안내만). Hermes 추출 경로가 추출 패키지를 실행 시점에 설치할 수 있으므로(`~/.hermes/hermes-agent/tools/read_extract.py:59-90`) 인바운드 문서 처리 전 설치 상태를 고정하는지 확인 필요입니다. 추출 텍스트는 신뢰할 수 없는 입력으로 다룹니다(THREAT_MODEL TM-ATT-09).

### 6-2. Web Push (R3.3, ADR-001 §3-i, PRD FR-CLIENT-05)

- 범위: 사람 계정의 구독 기기에 ① Jarvis DM의 새 최상위 메시지·자기 스레드에 사람이 단 답글 ② 채널 최상위 봇 게시(→ 그 채널의 사람 멤버 전원) ③ 자기가 쓴 원문의 스레드(Jarvis DM·채널)에 봇이 단 **결정 요청** 답글 ④ 자기 멘션을 보냅니다. 결정 요청 = 본문의 첫 비어 있지 않은 줄이 `⚠️ **Hermes wants to run a command that needs your OK**`(승인)로 시작하거나, `❓`(clarify)로 시작하거나, `[결정 필요]`를 포함할 때입니다(이모지 VS16 유무 무관, `modules/push/decision.ts` `isDecisionRequest`). 그 밖의 봇 답글(도구 진행 표시·일반 답변·승인 결과 등)은 멘션이 없으면 보내지 않습니다(R3.10). 사람이 채널에 쓴 글(최상위·스레드 답글)은 멘션만 보냅니다. 자기 메시지·이미 읽은 대화는 보내지 않습니다. 생성 후 전송 전에 삭제된 메시지는 보내지 않습니다(대상 질의와 매 전송 직전에 삭제 여부 재확인, 삭제되면 남은 대상 전송 중단). 같은 대화 알림은 60초 안에 1건으로 묶습니다(`Topic` 헤더로 교체).
- payload: `{v:1, kind:"message", conversation_id, message_id, thread_root_id?, from_bot:boolean}`만 보냅니다(식별자만, 본문 없음). 알림 탭 시 SW는 `message_id`(답글이면 `thread_root_id`의 스레드 안 `message_id`) 위치로 대화를 엽니다 — 알림 뒤 메시지가 더 쌓여도 해당 브리핑을 찾을 수 있게 하기 위함입니다(PRD S8). **본문·대화 이름·작성자 이름 미포함.** 알림 제목은 SW 고정(「ohmyslack」, 봇 발신이면 「Jarvis」)입니다. 알림 본문은 SW가 수신 뒤 로그인 세션(같은 출처 쿠키)으로 `GET /api/messages/{message_id}/preview`(§3)를 3초 타임아웃으로 가져온 평문 미리보기(최대 100 code point)이고, 실패(타임아웃·401/403/404·네트워크 오류·`null`·형식 이상)하면 고정 문구 「새 메시지가 있습니다」입니다(R3.9). 앱 안 미리보기 토글은 두지 않고 잠금 화면 노출은 OS 설정(iOS 「미리보기 표시」, Android 「민감한 알림 내용 숨기기」)으로 통제합니다. iOS는 silent push 금지이므로 SW는 `event.waitUntil(showNotification())`를 반드시 호출합니다.
- VAPID: P-256 키쌍을 로컬 명령 `apps/server/bin/vapid-keygen.ts`로 생성합니다. 개인키는 서버 비밀 파일(600, 저장소 밖)·환경 변수 경로로만 주입하고, 미설정 시 push 기능만 비활성(기동은 계속)하며 `/api/push/vapid-public-key`는 404입니다. `sub`는 `mailto:` 실제 주소(공백·꺾쇠 금지)입니다. 키 회전 = 전 구독 재등록(`vapid_key_id`로 구분).
- 전송: 서버 → push service outbound HTTPS. `TTL` 헤더 필수(제안 86400). 404·410 응답 시 구독을 삭제합니다. endpoint는 https + 호스트 허용목록(`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, 그리고 Chromium 계열 FCM 대체 호스트 `jmt<숫자>.google.com` — 경로 `/fcm/send/<token>`일 때만, 2026-11-16 운영 실측)만 등록합니다.
- 근거 URL: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ , https://webkit.org/blog/12945/meet-web-push/ , RFC 8030·8291·8292.
- **확인 필요:** tailnet 전용 origin(`*.ts.net`)에서의 iOS 홈 화면 PWA 구독·수신은 공식 근거가 없습니다. 개발설계서 W-23(Web Push)의 선행 조건으로 실기 시험(QA-FR-CLIENT-05)을 먼저 수행합니다(ADR-001 D-3).

## 7. NFR·운영

| ID | 미측정 제안 목표 |
|---|---|
| NFR-01 | 메시지 `seq` 유일·단조, global `change_id`는 commit 순서와 일치 |
| NFR-02 | 같은 client_message_id/payload 3회에도 메시지 1개; 다른 payload는 충돌 |
| NFR-03 | 60초 단절 중 생성 100건과 edit/delete 후 최종 상태 동일, 누락/중복 0 |
| NFR-04 | 10,000개 합성 이력 paging에서 경계 누락/중복 0 |
| NFR-05 | 20 연결·5 msg/s·10분에서 commit→열린 기기 표시 p95 ≤ 1초 목표 |
| NFR-06 | 열린 기기 읽음 배지 2초 내 일치, 오래된 cursor로 후퇴 없음 |
| NFR-07 | 모바일 5분 복귀 시 변경·읽음 sync 전 stale UI를 최신으로 표시하지 않음 |
| NFR-08 | 개인용 가용성은 Mac·전원·tailnet에 종속; 공용 SLA 없음 |

WebSocket heartbeat 제안은 25초 간격, 2회 연속 미응답 시 dead connection 정리입니다. 이는 모바일 네트워크에서 검증 전인 설정값입니다.

DB 연결 상한(앱 프로세스 pool만, CLI는 각자 기본값): pool 연결 대기·접속 5초(`connectionTimeoutMillis` — 기본 무한 대기라 연결이 정착하지 않으면 요청이 쌓임; 초과 시 HTTP 500 `db_pool_timeout`, 503은 게이트웨이 끊김 판정과 겹쳐 쓰지 않음), 서버측 `idle_in_transaction_session_timeout` 30초(트랜잭션 안에서 외부 I/O를 기다리는 정상 경로가 없으므로 넘긴 세션은 누수로 보고 끊음, 25P03), TCP keepalive 첫 탐침 10초(OS 기본 2시간이면 RST 없는 죽은 소켓을 못 봄). 전역 `statement_timeout`은 두지 않습니다 — 큰 첨부 bytea·긴 snapshot이 실측 전이라 잘릴 위험이 있고, 계측 쿼리만 트랜잭션 로컬 3초를 씁니다.

계측은 로컬 allowlist만 사용합니다: `message_send_result(outcome enum, conv_kind enum, has_thread boolean, duration_ms bucket)`, `sync_result(trigger enum, outcome enum, caught_up_count bucket, duration_ms bucket)`, `read_sync_result(outcome enum, duration_ms bucket)`, `auth_denied(action enum, reason enum, count)`, `client_state(state enum, count)`, `bot_delivery_result(direction enum{in,out}, outcome enum, has_attachment boolean, duration_ms bucket)`, `push_send_result(outcome enum{sent,expired,failed})`(R3.3, 식별자·본문·endpoint 미기록). metric key·enum·7일 보관은 PRD §10 정본을 따릅니다. 1단계 구현은 서버에서 결과가 확정되는 4종(`message_send_result`·`auth_denied`·`bot_delivery_result`·`push_send_result`)만 `metric_daily`에 기록하고(`duration_ms`는 `DURATION_BUCKETS_MS` 구간 하한, 메모리 합산 후 주기·종료 flush — 요청당 DB 쓰기 없음), 2단계는 클라이언트 3종(`sync_result`·`read_sync_result`·`client_state`)을 웹이 메모리에서 합산해 60초마다·`pagehide`/숨김 때 `POST /api/metrics`(§3 표)로 보냅니다(디스크 저장 없음, 실패분은 메모리 상한 안에서 다음 주기 재합산). `count`·`caught_up_count`는 `COUNT_BUCKETS`(0,1,2,5,…,1000 상한) 구간 하한만 허용합니다. PII·본문·식별자·IP·UA·raw error를 금지하며 합성 부하 결과는 환경·실패율과 함께 별도 기록합니다.

SQL migration은 순서형 파일로 관리하고 시작 시 암묵 변경하지 않습니다. 백업은 승인된 shared-infra 절차를 변경 없이 사용하는 안이며 이번에 실행하지 않았습니다. 복원은 격리 DB에서 message 수, edit/delete 상태, DM membership, seq/change cursor, read cursor를 대조합니다. 백업 보존·삭제 본문의 과거 사본 제거·RPO/RTO·복구 책임자는 확정 필요입니다.

## 8. 사실 / 추정 / 확인 필요

**사실:** PRD v1.2 §7-7은 스레드 unread 대상 자격·초기 cursor·집계 분리와 초기 관리자 운영 선행 증거를, §10은 계측 allowlist와 보관 기간을 정본으로 정했습니다. Round 2 브리프 0절에서 개인 tailnet, PostgreSQL 원장 다기기, 웹+PWA, Redis 미사용, 출시 없음이 확정됐습니다. PRD 정본은 FR ID·수용 기준·시나리오를 소유합니다. 개발설계서 정본은 저장소 구조·게이트·WBS·테스트·CI를, 디자인 레퍼런스 정본은 시각·반응형·IME 계약을 소유합니다. 설치 기록에 Node 26.12.1/pnpm 10.30.2가 적혀 있으나 운영 환경 확인은 하지 않았습니다.

**설계 제안:** 커밋순 전역 cursor로 다기기 복구를 단순화합니다. 본문 snapshot 없는 change log와 현재 상태 projection으로 삭제된 본문 재노출을 막습니다. 제안 수치(본문 4,000자, frame 64 KiB, 로그인 5회/15분, 세션 30일, change 보존 30일 또는 100,000건, heartbeat 25초)는 미측정이며 착수 전 확인할 운영값입니다.

**확인 필요:** PostgreSQL 실제 버전·접속 경계, Node LTS 상태와 package lock/runtime pin, password hash 라이브러리 파라미터, 첫 관리자 복구 절차의 최종 운영 방식, Serve 실제 설정, 백업 보존·삭제/RPO/RTO, 실제 타인 초대 승인, 지원 브라우저·호스트 가용성입니다. 이는 PRD §11의 운영 결정 대기 항목이며 문서 간 계약 충돌은 아닙니다. 이번 R3에서 코드·DB·`.env`·Tailscale 설정을 확인하거나 변경하지 않았습니다.

## 9. 공식 출처

아래 공식 문서 링크는 참고 출처이며, R3에서 페이지 본문·robots.txt·이용 약관을 새로 조회하지 않았습니다. 적용 버전과 운영 설정은 착수 때 검증해야 합니다.

- Tailscale Serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Tailscale Serve examples: https://tailscale.com/docs/reference/examples/serve
- Node.js release status: https://nodejs.org/en/about/previous-releases
- Node.js LTS/EOL: https://nodejs.org/en/about/eol
- MDN web app manifest: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest
- MDN standalone PWA: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Create_a_standalone_app
- MDN Service Worker API: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API

## 10. 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| R1 초안 | 2026-11-07 | 확정 결정, PRD, 개발설계서와 맞춘 시스템·DB·HTTP/WS·sync·보안·Tailscale·PWA·NFR 제안 |
| R3 최종안 | 2026-11-07 | R2 Must-fix 반영, 정본 문서 참조, 커밋순 전역 sync cursor·P0 API·읽음·삭제 replay·수치·DDL 계약 확정 |
| R3.1 (Jarvis 정합) | 2026-11-07 | 디자인 ⚖️-D1 해소: 전송 응답과 `message.created` projection에 `client_message_id` 추가(저장된 컬럼 노출만, 계약 의미 변경 없음). Node 26.13.0 LTS 확인(nodejs.org dist index, 2026-10-28 배포) — 착수 시 고정값 |
| R3.2 (Jarvis 보안 결정) | 2026-11-07 | 위협 모델 §6 공백 해소: §5-1 S1–S13, TR-SEC-11·12, 초대 폐기 route |
| R3.3 (ADR-001) | 2026-11-08 | Hermes 연동 P0 승격(영환님 결정, ADR-001 D-1–D-7 ★ 채택): `users.kind`·`bot_tokens`·`attachments`·`attachment_blobs`·`push_subscriptions`, 봇 리스너(§5-2), 첨부(§6-1)·Web Push(§6-2) 라우트, `author_kind`·`attachments` projection, 413/415, TR-SEC-13–15, §1·§6 「파일·Push MVP 제외」 문장 정정, 계측 2종 |
| R3.4 (BOT_CHANNEL_SPEC) | 2026-11-10 | 봇 채널 참여 P1 FR(영환님 결정, BOT_CHANNEL_SPEC §10-1 Q1–Q8 ★ 채택): §3 봇 추가·제거 라우트, §4 `membership.changed`, §5-2 (5) 공개 채널·수치 상한 없음·봇 읽기 `joined_seq` 이후, (6) 봇 `/me` 대화 종류·표시 이름 |
| R3.5 (ADR-002 §4) | 2026-11-13 | 문서 첨부 계약 §6-1-1 신설(영환님 결정 §4-3 5개 불변): 허용 형식 9종·ZIP/OLE 목록 판정·단일 일치·판정기 자원 상한·`has_macros`·확장자 일치 415·25 MiB 상수·업로드/봇 리스너 상한·파일명 정규화·`attachment` 다운로드·90일·드릴 측정 항목·Hermes 경계. §2 `attachments` 행에 `0005` 지시. 구현 전 계약(1b 레인) |
| R3.7 (p2s1-attach-order) | 2026-11-14 | 첨부 표시 순서(영환님 결정 2026-11-14): 메시지의 `attachments` 배열 = 전송 요청 `attachment_ids` 순서(응답·이력·답글·sync·WS·봇 경로 공통, 중복 ID 새 요청은 기존대로 400). §2 `attachments.bind_order`(마이그레이션 `0007`, 기존 행 NULL·백필 없음), §3 messages 행, §6-1 결속·projection 정렬. 멱등 비교는 집합 그대로(순서만 다른 재시도 = 원결과) |
| R3.8 (chdel-server) | 2026-11-22 | 채널 삭제(P1 FR FR-CONV-06, 영환님 요청): §3 `DELETE /api/conversations/{id}`(소프트 삭제·마이그레이션 `0008`·이름 재사용), §4 `conversation.deleted` 프레임 |
| R3.9 (push-preview) | 2026-11-26 | push 알림 본문 미리보기(영환님 지시 「미리보기 진행」): §3 `GET /api/messages/{id}/preview`, §6-2 표시 문구(제목 고정·본문 = 세션 조회 미리보기, 실패 시 고정 문구). payload 계약 변화 없음 |
| R3.10 (push-quiet) | 2026-11-28 | 푸시 수신 규칙 축소(영환님 요청): §6-2 봇 스레드 답글은 결정 요청(승인·clarify·`[결정 필요]`)일 때만 원문 작성자에게. 봇 최상위 게시·멘션·payload 계약 변화 없음 |

## 리뷰 반영 기록

| 리뷰어 | 항목 ID | 처리(반영/거절/부분) | 변경 위치 또는 거절 근거 |
|---|---|---|---|
| GPT-Sol | SOL-T1 | 반영 | `docs/03-trd/TRD.md:66`, `:94`, `:124` |
| GPT-Sol | SOL-T2 | 반영 | `docs/03-trd/TRD.md:70`, `:99`, `:118`, `:124` |
| GPT-Sol | SOL-T3 | 반영 | `docs/03-trd/TRD.md:50`–`:62`, `:82`–`:105`, `:141`–`:151` |
| GPT-Sol | SOL-T4 | 반영 | `docs/03-trd/TRD.md:54`, `:69` |
| Claude-Opus 5.5 | M-T1 | 반영 | `docs/03-trd/TRD.md:53`, `:66`, `:94`, `:124` |
| Claude-Opus 5.5 | M-T2 | 반영 | `docs/03-trd/TRD.md:54`, `:69`, `:94` |
| Claude-Opus 5.5 | M-T3 | 반영 | `docs/03-trd/TRD.md:82`–`:96`, `:103` |
| Claude-Opus 5.5 | M-T4 | 반영 | `docs/03-trd/TRD.md:99`, `:118`, `:124` |
| Claude-Opus 5.5 | M-T5 | 반영 | `docs/03-trd/TRD.md:50`, `:52`, `:64` |
| Claude-Opus 5.5 | M-T6 | 반영 | `docs/03-trd/TRD.md:25`, `:134`–`:141`, `:177` |
| Claude-Fable | T-1 | 반영 | `docs/03-trd/TRD.md:53`, `:66`, `:94`, `:124` |
| Claude-Fable | T-2 | 반영 | `docs/03-trd/TRD.md:54`, `:69`, `:94` |
| Claude-Fable | T-3 | 반영 | `docs/03-trd/TRD.md:82`–`:105` |
| Claude-Fable | T-4 | 반영 | `docs/03-trd/TRD.md:118` |
| Claude-Fable | T-5 | 반영 | `docs/03-trd/TRD.md:99`, `:70` |
| Claude-Fable | T-6 | 반영 | `docs/03-trd/TRD.md:25`, `:134`–`:141`, `:177`, `:185` |
| Claude-Fable | T-7 | 반영 | `docs/03-trd/TRD.md:91`–`:92`, `:122` |
