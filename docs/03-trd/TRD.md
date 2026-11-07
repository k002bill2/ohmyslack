---
title: "ohmyslack 기술요구사항 — GPT-Luna"
tags: [ohmyslack, trd, architecture]
status: active
created: 2026-11-07
---

# TRD — ohmyslack (내부 코드명)

- 상태: R3 최종안
- 작성자: GPT-Luna
- 입력: BUZZ_ROUND2_DOCS.md, BUZZ_ROUND3_FINAL.md, PRD v1.2 R3, R1 개발설계서·디자인 레퍼런스, GPT-Sol·Claude-Opus·Claude-Fable R2 리뷰
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
~~~

스택은 React + TypeScript + Vite, Node.js + Fastify, PostgreSQL, 같은 앱의 PWA입니다. 설치 기록의 Node 26.12.1은 확인된 설치 버전이지 승인된 runtime pin은 아닙니다. 목표 major는 Node 26이며, 착수 때 공식 Node.js release 표에서 26.x가 지원 LTS인지 확인하고 그 LTS 최신 보안 패치의 정확한 버전을 `.nvmrc`, `engines`, CI, lockfile에 함께 고정합니다. 26.x가 아직 지원 LTS가 아니면 당시 지원 중인 LTS major를 사용하고 이 문서를 갱신합니다. PostgreSQL 운영 버전과 연결 경계는 착수 전 확인 항목입니다.

MVP는 본인 다기기 대화 동기화, 합성 계정으로 초대·DM 권한 검증, 채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·실시간·복구·모바일 PWA입니다. 타인 초대/tailnet 추가는 별도 승인입니다. Redis, Slack API/브리지, 오프라인 발신 큐, 사용자 본문 지속 캐시, 파일, 검색, presence, Push, 네이티브 앱, Electron은 MVP 의존성에서 제외합니다.

## 2. 데이터 모델

UUID는 공개 개체 ID, `timestamptz`는 UTC 시각입니다. 아래는 구현 가능한 제약의 계약이며, 구체적인 migration 문법은 개발설계서의 저장소 규칙을 따릅니다. 모든 FK는 아래에서 정한 `ON DELETE`를 사용합니다. 사용자를 비활성화할 때는 `users.status`만 바꾸며, `workspace_members`에는 중복 status를 두지 않습니다.

| 테이블 | 주요 필드·제약 | 역할 |
|---|---|---|
| `workspaces` | `id uuid PK`, `name text NOT NULL`, `created_at timestamptz NOT NULL` | 고정 1개. 참조 FK는 `ON DELETE RESTRICT` |
| `users` | `id uuid PK`, `email_norm text UNIQUE NOT NULL`, `display_name text NOT NULL`, `password_hash text NOT NULL`, `status text NOT NULL CHECK (status IN ('active','disabled'))` | 실제 계정 1명과 합성 계정. 비활성화의 기준 필드 |
| `workspace_members` | `workspace_id`, `user_id`, `role text CHECK (role IN ('owner','member')) NOT NULL`, composite PK, 두 FK `ON DELETE RESTRICT` | 단일 workspace 멤버십·관리 권한 |
| `invites` | `id uuid PK`, `token_hash text UNIQUE NOT NULL`, `created_by uuid NOT NULL`, `expires_at timestamptz NOT NULL`, nullable `used_at timestamptz`, nullable `revoked_at timestamptz` | 만료·1회 사용. 사용자 FK `RESTRICT`, token 원문 미저장 |
| `sessions` | `id uuid PK`, `user_id uuid NOT NULL`, `token_hash text UNIQUE NOT NULL`, `created_at timestamptz NOT NULL`, `last_seen_at timestamptz NOT NULL`, `expires_at timestamptz NOT NULL`, nullable `revoked_at timestamptz` | 기기별 세션. 사용자 FK `ON DELETE CASCADE` |
| `conversations` | `id uuid PK`, `workspace_id uuid NOT NULL`, `kind text CHECK (kind IN ('channel','dm')) NOT NULL`, nullable `name text`, nullable `name_norm text`, nullable `normalized_pair_key text`, `last_seq bigint NOT NULL DEFAULT 0`, `created_at timestamptz NOT NULL`; unique `(workspace_id,id)` | `workspace_id` FK `RESTRICT`; 채널은 `(workspace_id,name_norm)` 부분 unique; DM은 `normalized_pair_key` 부분 unique |
| `conversation_members` | `(conversation_id,user_id)` PK, `joined_at`, `joined_seq bigint`, nullable `left_at` | 양 FK `RESTRICT`; 재참여 시 `joined_seq=last_seq`로 갱신. 접근은 현재 `left_at IS NULL`만 허용 |
| `messages` | `id uuid PK`, `conversation_id uuid NOT NULL`, `seq bigint NOT NULL`, `author_id uuid NOT NULL`, `client_message_id uuid NOT NULL`, nullable `thread_root_id uuid`, nullable `body text`, `created_at timestamptz NOT NULL`, nullable `edited_at timestamptz`, nullable `deleted_at timestamptz`; unique `(conversation_id,id)`, `(conversation_id,seq)`, `(conversation_id,author_id,client_message_id)` | 대화 FK `RESTRICT`, 작성자 FK `RESTRICT`, `(conversation_id,thread_root_id)` 자기참조 FK `RESTRICT`; tombstone 외에는 body NOT NULL |
| `sync_clock` | singleton `id integer PRIMARY KEY CHECK(id=1)`, `last_change_id bigint NOT NULL DEFAULT 0` | 전역 커서 할당 잠금 행. 서비스 시작 시 1행 생성 |
| `conversation_changes` | `change_id bigint UNIQUE NOT NULL`, `conversation_id uuid NOT NULL`, `message_id uuid NOT NULL`, `op text CHECK (op IN ('create','edit','delete')) NOT NULL`, `created_at timestamptz NOT NULL` | 전역 변경 로그. message FK `RESTRICT`; 메시지 본문·mention snapshot은 저장하지 않음 |
| `conversation_read_state` | `(conversation_id,user_id)` PK, `last_read_seq bigint NOT NULL`, `updated_at` | 대화 본문 읽음 위치 |
| `thread_read_state` | `(root_message_id,user_id)` PK, `last_read_seq bigint NOT NULL`, `updated_at` | 스레드별 읽음 위치. root FK `RESTRICT` |
| `thread_unread_targets` | `(root_message_id,user_id)` PK, `qualified_at timestamptz NOT NULL` | PRD §7-7의 스레드 대상 자격을 기록; 편집·삭제 뒤에도 자격 유지. root/user FK `RESTRICT` |
| `message_mentions` | `(message_id,user_id)` PK | 메시지와 멤버 FK `RESTRICT`; 수정 시 재계산, 삭제 시 같은 트랜잭션에서 제거 |

모든 `id`, `*_id`, `user_id`, `conversation_id`, `workspace_id`는 `uuid NOT NULL`이며 PK/FK 구성 컬럼은 예외 없이 타입이 일치합니다. 식별·관계 컬럼은 PK, FK, nullable 표기가 없는 한 `NOT NULL`입니다. 시각은 `timestamptz NOT NULL`(nullable로 표시된 종료·폐기 시각 제외), 정렬·읽음·변경 cursor는 `bigint NOT NULL`입니다. enum은 표의 `CHECK` 허용값으로 제한합니다. `name_norm`은 channel 행에서 필수, `normalized_pair_key`는 DM 행에서 필수입니다. `messages.body`/`deleted_at` 조합은 미삭제 본문 또는 삭제 tombstone만 허용합니다.

필수 인덱스: `messages(conversation_id,seq DESC)`, `messages(conversation_id,thread_root_id,seq)`, `conversation_changes(change_id)`, `conversation_changes(conversation_id,change_id)`, `conversation_members(user_id,conversation_id)`, `message_mentions(user_id,message_id)`. 메시지 본문은 `text NOT NULL`이며 `length(body) <= 4000`; 삭제 행은 `body IS NULL AND deleted_at IS NOT NULL`입니다. 빈 메시지는 거부합니다. 길이는 Unicode code point 기준입니다.

채널 이름은 앞뒤 공백을 제거하고 Unicode NFC 정규화 후 case-fold한 `name_norm`으로 유일성을 검사합니다. DM 쌍 키는 두 사용자 UUID를 정렬해 만든 고정 표현이며, 두 사용자 멤버십은 생성 트랜잭션에서 함께 만듭니다. `thread_root_id` 복합 FK는 `(conversation_id,id)` unique key를 참조하며 원문은 같은 대화에 있어야 하고 그 원문 자체는 `thread_root_id IS NULL`이어야 합니다. 복합 FK와 서비스 검증으로 대화 경계를 보장하고, root가 답글인 입력은 거부합니다. 물리 삭제 대신 tombstone을 사용합니다.

메시지 생성·수정·삭제는 membership 확인과 관련 row 잠금, 메시지·mention·change 기록을 단일 트랜잭션으로 처리합니다. 메시지별 `seq`는 conversation 행 잠금 안에서 증가합니다. 전역 `change_id`는 매 변경 트랜잭션에서 `sync_clock` singleton row를 갱신해 할당합니다. 이 row 잠금은 직전 변경 트랜잭션이 commit/rollback할 때까지 유지되므로 커서 순서가 commit 순서와 일치합니다. PostgreSQL sequence의 할당 순서에 기대지 않습니다. 메시지 변경과 커서 갱신은 원자적입니다. 같은 `(conversation_id, author_id, client_message_id)`와 같은 payload 재시도는 원래 결과를 반환하고, 다른 payload는 409입니다. ACK와 WS 알림은 commit 이후에만 발생합니다.

수정 이력은 `conversation_changes`의 본문 없는 식별자·op 기록과 현재 `messages` 상태를 함께 사용합니다. sync는 변경 row를 그대로 내보내지 않고 페이지 내 message id를 모아 현재 상태로 접습니다. 삭제된 메시지는 body와 mention이 없는 tombstone으로만 응답하고, 삭제 트랜잭션은 mention row를 제거합니다. 따라서 삭제 이후 과거 커서부터 여러 페이지를 재생해도 본문 snapshot이 재등장하지 않습니다. 백업 보존 중인 과거 사본 제거는 서비스 sync replay와 별개인 보존 정책입니다.

읽음 상태는 계정 기준 `max(current, request)`로만 증가합니다. 멤버십 생성/재참여 때 `joined_seq=conversations.last_seq`를 저장하고 본문 read cursor도 이 값으로 초기화해 이전 대화가 신규 unread가 되지 않게 합니다. seq 숫자에 중간 값이 없어도 원문/답글/삭제로 생긴 정상 간격이므로, read cursor는 현재 화면에서 정렬된 대상 종류의 마지막 표시 메시지로 판정합니다. 사용자가 원문을 작성하거나 답글을 작성하거나 다른 사용자가 보낸 메시지에서 mention을 받으면 해당 `(root_message_id,user_id)`를 `thread_unread_targets`에 삽입합니다. 스레드 read-state가 없는 대상 사용자는 초기 cursor를 `joined_seq`로 취급하므로 멤버십 이후의 접근 가능한 답글을 unread로 셉니다. 자격을 얻은 뒤 mention/답글이 수정·삭제돼도 대상 행은 유지하며, 접근을 잃으면 목록/집계에서 제외합니다. 단순히 스레드를 열어 본 것은 대상 자격을 만들지 않습니다. read cursor가 이미 더 앞서 있으면 뒤로 이동시키지 않습니다. 본문 읽음은 실제 화면에서 마지막으로 연속 표시한 top-level `seq`, 스레드 읽음은 해당 root의 실제 답글 중 마지막 연속 표시 위치여야 합니다. 서버는 대상 대화/root의 membership, root가 top-level인지, 요청 seq가 그 범위에서 실제로 존재하는 최대 seq 이하인지 확인하고 범위 밖 요청은 400으로 거부합니다. 자기 메시지와 삭제 tombstone은 unread에서 제외합니다.

## 3. HTTP 계약

모든 요청은 same-origin JSON, UUID, UTC RFC3339를 사용합니다. 사용자 권한은 서버 세션으로 결정하고 body의 `user_id`를 권한 판정에 사용하지 않습니다. 목록은 cursor paging, 최대 100개이며 offset은 금지합니다. 오류는 `{error:{code,request_id}}`이며 본문·token·SQL·stack을 포함하지 않습니다.

| Route | 계약·권한 |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout` | 로그인·현재 기기 로그아웃. DB 세션 즉시 revoke |
| `GET /api/me`, `GET /api/sessions` | 현재 계정·기기 세션. 원격 기기 revoke는 P1 |
| `POST /api/invites`, `POST /api/invites/accept` | owner 발급, 만료/1회 token 원자적 교환; 외부 메일 없음 |
| `GET /api/members` | 활성 멤버 목록(초대·DM·멘션 후보). 본인 계정 세션 필요 |
| `POST /api/admin/members/{user_id}/deactivate` | owner 전용. `users.status=disabled`, 세션 revoke, WS close |
| `GET /api/conversations` | 현재 접근 가능한 대화와 unread 요약. 대화별 추가 unread 호출 금지 |
| `GET /api/conversations/discover?after=&limit=` | 아직 참여하지 않은 공개 채널 목록. join 전에는 메시지·멤버 정보를 반환하지 않음 |
| `POST /api/conversations` | `{kind:"channel",name}` 채널 생성. owner 전용(PRD FR-CONV-01) |
| `POST /api/conversations/{id}/join`, `DELETE /api/conversations/{id}/membership` | 공개 채널 참여·나가기. 나간 뒤 구독 즉시 해제 |
| `POST /api/dms` | `{user_id}`로 DM 시작. 정렬된 pair key로 동시 중복 생성 방지 |
| `GET /api/conversations/{id}/members` | 활성 참여자 목록. 참여자만 접근 |
| `GET /api/conversations/{id}/messages?before_seq=&after_seq=&around_seq=&limit=` | 접근 가능한 대화 이력. `roots_only=true`로 본문만, 기본 최대 100건 |
| `GET /api/messages/{root_id}/replies?before_seq=&after_seq=&limit=` | 1단 답글 목록. root 대화 접근 검사 |
| `POST /api/conversations/{id}/messages` | `{client_message_id,body,thread_root_id?}`; 생성 메시지(`client_message_id` 포함)·seq·global `change_id` 반환 |
| `PATCH /api/messages/{id}` | 작성자만 수정. 새 `change_id`, 수정된 mention ID 반환 |
| `DELETE /api/messages/{id}` | 작성자만 tombstone 처리. 과거 본문/mention replay 방지 |
| `GET /api/sync?after={change_id}&through={change_id?}&limit=` | 계정 전역 catch-up. 첫 페이지에서 watermark `through_cursor` 확정, 후속 페이지에 그대로 전달 |
| `GET /api/sync/snapshot?conversation_id=&before_seq=&limit=` | cursor 만료(410) 또는 새 기기 초기화. 응답에 요청 시작점의 `snapshot_cursor`, 선택 대화의 현재 메시지 상태 페이지, `has_more`와 `next_before_seq` 포함 |
| `PUT /api/read-state` | `{conversation_id,thread_root_id?,last_read_seq}`; 유효 위치 검사 후 단조 병합 |
| `GET /api/healthz` | 비민감 상태만 공개 |

`GET /api/conversations` 각 항목은 `last_seq`, `last_read_seq`, `unread_count`, `mention_count`, `unread_thread_count`, `unread_threads[{root_message_id,last_read_seq,last_reply_seq,unread_reply_count,mention_count}]`를 포함합니다. 본문 `unread_count`는 읽지 않은 top-level 원문만 셉니다. `unread_threads`는 PRD §7-7에서 정한 자격이 있는 스레드만 포함하고, 대상별 `unread_reply_count`는 자기 답글·삭제 답글을 제외합니다. `mention_count`는 본인이 작성하지 않은 접근 가능 미열람 원문/답글에서 본인을 대상으로 한 mention만 세며, 본문 수에 스레드 수를 더하지 않습니다. 이 목록 응답은 사이드바 badge와 복귀 후 read-state snapshot의 데이터원이며 N+1 unread 요청을 만들지 않습니다. 답글 화면은 replies 응답과 사용자 read state로 표시합니다.

`/api/sync`는 전역 커서 기준으로 요청 `limit`은 1–500으로 제한하며 페이지당 최대 500개 change row를 스캔하고 `scanned_through`, `through_cursor`, `has_more`, `next_cursor`를 반환합니다. 현재 membership이 있는 대화의 변경만 payload에 싣고, cursor 자체는 모든 row를 안전히 스캔한 위치까지 전진시킵니다. 첫 페이지의 watermark는 해당 요청 시작 시점의 마지막 commit cursor입니다. 후속 페이지는 그 watermark까지만 읽으며, watermark에 도달하면 다음 동기화부터 더 새로운 변경을 읽습니다. 적용 키는 `change_id`; 메시지 projection은 message id와 최신 `seq/edited_at/deleted_at`을 사용해 중복 적용에 안전합니다. cursor가 보존 경계보다 오래됐으면 410을 반환합니다.

새 기기에 저장된 sync checkpoint가 없으면 먼저 현재 conversation list와 read snapshot을 읽고, 활성 대화별 `GET /api/sync/snapshot?conversation_id=...`에서 최근 100개 메시지 단위의 현재 상태를 채웁니다. 오래된 이력은 일반 messages paging으로 요청합니다. 첫 snapshot 응답의 `snapshot_cursor` 이후 모든 대화 snapshot 완료까지 `/api/sync?after=snapshot_cursor`로 다시 catch-up하고, conversation list/read snapshot을 한 번 더 읽은 뒤 catch-up watermark를 기기 checkpoint로 저장합니다. cursor 만료(410)도 같은 절차를 사용합니다. 체크포인트는 기기별 숫자 metadata만 저장할 수 있고 메시지 본문·인증 응답은 지속 저장하지 않습니다. 이 절차가 끝날 때까지 UI는 최신으로 표시하지 않습니다.

상태 코드는 400 입력/범위 오류, 401 인증 또는 비활성 계정, 403 참여자가 관리자 권한/타인 메시지 쓰기를 요청한 경우, 404 비멤버가 대화 단위 자원에 접근한 경우(존재 은폐), 409 멱등 충돌, 410 만료 cursor, 429 로그인 제한, 5xx 일반 오류입니다. 모든 route에 schema와 payload 상한 검증을 적용합니다.

## 4. WebSocket·동기화

Endpoint는 same-origin `/api/ws`입니다. handshake에서 cookie session, 정확한 Origin, 활성 사용자 확인을 합니다. 모든 대화 접근은 개발설계서 정본의 `conversations.service.assertAccess(userId, conversationId, action)` 단일 경계를 통과합니다.

| 이벤트 | 방향·필드 |
|---|---|
| `conversation.subscribe` | client→server: `conversation_id`, `after_cursor`(마지막 완료된 sync checkpoint) |
| `conversation.subscribed` | server→client: `conversation_id`, `through_cursor` ACK |
| `message.created` | server→client: `conversation_id`, `change_id`, `message{id,seq,author_id,client_message_id,thread_root_id,body,created_at,mention_user_ids,root_reply_count?}` |
| `message.updated` | server→client: `conversation_id`, `change_id`, 현재 message projection 및 `mention_user_ids` |
| `message.deleted` | server→client: `conversation_id`, `change_id`, `message_id`, `seq`, `deleted_at`; body·mention 없음 |
| `read.updated` | server→client: `conversation_id`, `thread_root_id?`, `last_read_seq`, `updated_at`; null root은 본문 읽음 |
| `sync.required` | server→client: REST catch-up 수행 지시 |
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
- 메시지는 안전한 text node로 렌더합니다. 줄바꿈·코드 fence는 inert text/code block으로 표시하고, 자동 링크는 `https`·`http`만 허용합니다. raw HTML과 다른 위험 scheme은 실행하지 않습니다. 메시지 본문 최대 4,000 Unicode code point, WS frame 최대 64 KiB입니다. 초과 입력은 저장 전에 거부합니다.
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
| TR-SEC-07 | tailnet 전용 노출 | 앱 listener는 loopback만; public port·Funnel 없음; Tailscale Serve HTTPS endpoint 허용 |
| TR-SEC-08 | 사용자 본문 지속 캐시 금지 | Cache API/IndexedDB/localStorage에 본문·인증 응답 없음 |
| TR-SEC-09 | 개인정보 없는 계측 allowlist | 허용목록 외 필드 0; 계측 실패가 메시지 처리를 막지 않음 |
| TR-SEC-10 | 백업/복원 경계 | 별도 승인·격리 복원 대조; shared-infra 변경 없음 |

위 표는 설계 제안이며 보안 감사나 구현 검증 결과가 아닙니다. 코드·DB·`.env`·인증정보·shared-infra에 접근하지 않았습니다.

## 6. Tailscale Serve와 PWA

Tailscale Serve HTTPS는 tailnet에서 로컬 reverse proxy로 제안합니다. 앱 백엔드 listener는 `127.0.0.1:<port>`만 사용하며, tailnet HTTPS 접점은 Tailscale Serve가 제공합니다. Funnel, router port forwarding, LAN bind, `0.0.0.0` listener는 금지합니다. Serve hostname은 비밀이 아니므로 앱 인증을 유지하고 Mac sleep/offline은 명시적으로 표시합니다. DB port는 Serve하지 않습니다.

PWA manifest는 승인된 배포 이름, `start_url=/`, `scope=/`, `display=standalone`을 사용합니다. 아이콘 세트와 관련 크기·purpose·apple touch icon은 디자인 레퍼런스 §9-2 정본을 따릅니다. service worker는 해시된 app shell 정적 파일만 캐시하고 `/api/**`, 메시지·읽음·인증·초대 응답과 WS를 우회합니다. 본문은 Cache API·IndexedDB·localStorage에 저장하지 않고 화면 메모리에서만 일시 보유합니다. 오프라인 발신 큐는 없고 server ACK 전 성공 표시도 없습니다. 로그아웃 시 화면 데이터를 비웁니다.

반응형 구간·레이아웃 폭·IME·키보드 동작·상태 문구는 디자인 레퍼런스의 브레이크포인트·레이아웃·IME 규칙을 정본으로 따릅니다. PWA Push/offline messaging을 약속하지 않습니다. iOS Safari별 설치·cookie·WS 동작은 QA 확인 대상입니다.

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

계측은 로컬 allowlist만 사용합니다: `message_send_result(outcome enum, conv_kind enum, has_thread boolean, duration_ms bucket)`, `sync_result(trigger enum, outcome enum, caught_up_count bucket, duration_ms bucket)`, `read_sync_result(outcome enum, duration_ms bucket)`, `auth_denied(action enum, reason enum, count)`, `client_state(state enum, count)`. metric key·enum·7일 보관은 PRD §10 정본을 따릅니다. PII·본문·식별자·IP·UA·raw error를 금지하며 합성 부하 결과는 환경·실패율과 함께 별도 기록합니다.

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
