---
title: "ohmyslack 기술요구사항 — GPT-Luna"
tags: [ohmyslack, trd, architecture]
status: draft
created: 2026-11-07
---

# TRD — ohmyslack (내부 코드명)

- 상태: R1 초안
- 작성자: GPT-Luna
- 입력: BUZZ_ROUND2_DOCS.md, DISCUSSION_SYNTHESIS.md, GPT-Luna.md, GPT-Sol.md, PRD.md, DEV_DESIGN.md, CLEANROOM.md
- 정합성 가정: Sol R1의 P0 FR ID를 유지합니다. 추가 FR-AUTH-06, FR-SYNC-06/07, FR-CLIENT-07 및 P0로 승격된 FR-CLIENT-04를 포함합니다. Opus R1의 apps/web·apps/server·packages/shared 구조와 API/WS 이름을 맞췄습니다. 확정 이름은 R3 대상입니다.

## 1. 시스템과 범위

확정 방향은 개인 전용 메신저입니다. 영환님 계정 하나로 Mac·다른 Mac·휴대폰이 로그인하며, 앱 인증과 Tailscale 접근 인증은 별개입니다. Mac에서 단일 Fastify 프로세스와 PostgreSQL을 구동합니다. DB가 대화·읽음 상태의 단일 원장이고 WebSocket은 best-effort 알림 경로입니다. 모바일 웹과 PWA는 MVP입니다.

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
           messages + changes + seq + read cursors
~~~

스택은 React + TypeScript + Vite, Node.js + Fastify, PostgreSQL, 같은 앱의 PWA입니다. 브리프에 기록된 설치 버전은 Node 26.12.1/pnpm 10.30.2이지 최종 runtime 승인값은 아닙니다. 착수 시 지원 중인 Node LTS 패치와 Fastify/플러그인 호환 버전을 정확히 고정하고 runtime 파일·CI·lockfile을 일치시킵니다. PRD가 지정하지 않은 버전 범위는 임의로 확정하지 않습니다. shared-infra PostgreSQL 버전은 착수 전 확인합니다. NestJS는 현재 확인된 운영 이점이 없어 선택하지 않습니다.

MVP는 본인 다기기 대화 동기화, 합성 계정으로 초대·DM 권한 검증, 채널·1:1 DM·1단 스레드·수정/삭제·멘션·unread·실시간·복구·모바일 PWA입니다. 타인 초대/tailnet 추가는 별도 승인입니다. Redis, Slack API/브리지, 오프라인 발신 큐, 사용자 본문 지속 캐시, 파일, 검색, presence, Push, 네이티브 앱, Electron은 MVP 의존성에서 제외합니다.

## 2. 데이터 모델 (DDL 수준)

PK는 UUID, 시각은 UTC timestamptz, FK/delete 동작은 명시합니다. 테이블명은 R1 가정입니다.

| 테이블 | 주요 필드·제약 | 역할 |
|---|---|---|
| workspaces | id PK, name, created_at | 초기 한 개 |
| users | id PK, email_norm UNIQUE, display_name, password_hash, status | 실제 계정 1명; A/B/C는 격리 합성 계정 |
| workspace_members | workspace_id, user_id, role, status; composite PK | 활성 사용자 확인 |
| invites | id PK, token_hash UNIQUE, created_by, expires_at, used_at, revoked_at | 만료·1회 사용, 원문 token 미저장 |
| sessions | id PK, user_id, token_hash UNIQUE, expires_at, revoked_at | 기기별 세션 |
| conversations | id PK, kind, normalized_pair_key, name, last_seq, last_sync_cursor | channel/dm, DM 멤버 쌍 unique |
| conversation_members | conversation_id, user_id, joined_at, left_at; composite PK | 공통 접근 경계 |
| messages | id PK, conversation_id, seq, author_id, client_message_id, thread_root_id, body, created_at, edited_at, deleted_at; unique(conversation_id,seq), unique(conversation_id,author_id,client_message_id) | 1단 스레드와 멱등 전송 |
| conversation_changes | conversation_id, sync_cursor, message_id, op, snapshot, created_at; unique(conversation_id,sync_cursor) | create/edit/delete 내구성 변경 로그 |
| conversation_read_state | conversation_id, user_id, last_read_seq, updated_at; composite PK | 채널 unread 위치 |
| thread_read_state | root_message_id, user_id, last_read_seq, updated_at; composite PK | 스레드 unread 위치 |
| message_mentions | message_id, user_id; composite PK | 멤버 ID mention |

메시지 정렬용 seq와 변경 복구용 sync_cursor는 분리합니다. 생성 트랜잭션은 membership 확인, conversation 행 잠금, 두 cursor 증가, message 및 change row 기록을 원자적으로 수행합니다. 수정·삭제도 sync_cursor를 증가시킵니다. 같은 client_message_id와 payload 재시도는 기존 결과, 다른 payload는 409입니다. 저장 ACK와 WS 이벤트는 DB commit 후에만 발행합니다.

삭제는 본문을 제거한 tombstone을 남기고 답글은 보존합니다. 서비스 이력·복구 응답은 삭제 본문과 mention을 내보내지 않습니다. 과거 백업의 본문 물리 제거는 보존 정책 결정 대상입니다. 읽음 cursor는 계정 기준 max(current, request)로만 증가하며 채널·스레드별로 분리합니다. 실제 전경에서 본 마지막 연속 seq까지만 읽음입니다. 자기 메시지/삭제 tombstone은 unread에서 제외하고, 본인 메시지는 다른 본인 기기에도 전달합니다.

## 3. HTTP 계약 (R1 초안)

모든 요청은 same-origin JSON, UUID, UTC RFC3339를 사용합니다. 사용자 권한은 서버 세션으로 결정하며 body의 user_id를 신뢰하지 않습니다. 목록은 cursor paging, 최대 100개이며 offset 금지입니다. 오류는 {error:{code,request_id}} 형식이고 본문·token·SQL·stack을 포함하지 않습니다.

| Route | 계약 |
|---|---|
| POST /api/auth/login, /logout | 로그인·현재 기기 로그아웃, DB 세션 즉시 revoke |
| GET /api/me, /api/sessions | 현재 계정·기기 세션; 원격 기기 revoke는 P1 |
| POST /api/invites, /api/invites/accept | 관리자 발급, 만료/1회 token 원자적 교환; 외부 메일 없음 |
| GET /api/conversations | 접근 가능한 목록; DM은 참여자만 |
| GET /api/conversations/{id}/messages?before_seq=&limit= | 권한 검사 후 seq cursor 이력 |
| POST /api/conversations/{id}/messages | client_message_id, body, thread_root_id?; message_id/seq/sync_cursor 반환 |
| PATCH/DELETE /api/messages/{id} | 작성자 검사, edit/tombstone, 새 sync_cursor 반환 |
| GET /api/sync?since={cursor} | create/edit/delete 변경을 cursor 순으로 재생; 만료 cursor는 410과 전체 snapshot 요구 |
| PUT /api/read-state | conversation_id, thread_root_id?, last_read_seq; max 병합 |
| GET /api/conversations/{id}/unread | 채널·스레드 unread 및 mention 집계 |
| GET /api/healthz | 비민감 상태만 공개 |

상태 코드는 400 입력, 401 인증/비활성, 403 권한, 404 접근 불가 리소스(존재 은폐), 409 멱등 충돌, 410 만료 sync cursor, 429 로그인 제한, 5xx 일반 오류입니다. 모든 route에 schema·payload 상한 검증을 적용합니다.

## 4. WebSocket·동기화

Endpoint는 same-origin /api/ws입니다. handshake에서 cookie session, 정확한 Origin, 활성 사용자 확인. 모든 구독은 Claude-Opus 개발설계서의 conversations.service.assertAccess(userId, conversationId, action) 경계를 통과합니다.

| 이벤트 | 방향·필드 |
|---|---|
| conversation.subscribe | client→server: conversation_id, after_cursor |
| message.created | server→client: conversation_id, sync_cursor, message{id,seq,author_id,thread_root_id,body,created_at} |
| message.updated | server→client: conversation_id, sync_cursor, message_id, seq, body, edited_at |
| message.deleted | server→client: conversation_id, sync_cursor, message_id, seq, deleted_at; 본문 없음 |
| read.updated | server→client: conversation_id, last_read_seq; 본인 기기에 fan-out |
| sync.required | server→client: REST catch-up 수행 지시 |
| error | 비민감 code, retryable |

재접속 순서는 세션 확인 → cursor 확인 → GET /api/sync?since=로 catch-up → subscribe → 서버/로컬 cursor 재비교로 경합 보정입니다. 중복은 sync_cursor로 제거합니다. cursor 만료 시 snapshot으로 다시 동기화하고 완료 전 최신 상태로 표시하지 않습니다. 모바일 5분 백그라운드 복귀도 인증·변경·삭제·읽음을 재동기화합니다. 서버는 commit 후 WS로 전달하며, 이벤트 유실은 DB 변경 로그에서 회복합니다. 메모리 연결 목록은 전달 최적화만 담당합니다.

## 5. 인증·TR-SEC

- 앱 인증은 tailnet 인증과 독립입니다. PRD 입력에 따라 이메일+비밀번호. 검증된 password hashing library와 구현 시점의 안전 설정을 사용합니다. 첫 관리자 생성·복구는 외부 메일 없는 로컬 운영 절차로 결정합니다.
- 무작위 세션 token은 DB에 hash만 저장합니다. Cookie는 HttpOnly, Secure, SameSite=Lax, Path=/, host-only. revoke/비활성화 후 5초 안에 해당 WS를 닫습니다.
- 상태 변경 HTTP는 session-bound CSRF custom header와 정확한 Origin 검사를 모두 통과해야 합니다. GET/HEAD 부작용 금지.
- WS handshake와 각 subscription에서 cookie session·Origin·membership 확인. 인증 token은 URL·localStorage·로그에 두지 않습니다.
- 대화 목록·이력·수정·삭제·읽음·sync·subscribe 모두 같은 서버 접근 검사. 비참여자는 DM 존재도 추론할 수 없습니다.
- 메시지는 plain text 및 안전한 text node로만 렌더합니다. raw HTML과 위험 scheme은 실행하지 않습니다. 길이/frame 상한, 로그인 rate limit, 계정 존재를 드러내지 않는 오류 응답을 둡니다.
- 로그·계측에서 본문·초안·이메일·IP·user agent·식별 ID·token·cookie·URL query·raw stack을 제외합니다.

| ID | 요구사항 | 수용 기준 제안 |
|---|---|---|
| TR-SEC-01 | 매 요청 세션·활성 membership 확인 | 합성 비참여자의 목록·이력·sync·쓰기·구독 결과 0 |
| TR-SEC-02 | 비밀번호/세션/초대 secret 원문 미저장 | DB·로그에서 표식 원문 0 |
| TR-SEC-03 | CSRF header + Origin 검증 | 잘못된 출처 요청의 변경 0 |
| TR-SEC-04 | revoke·비활성화 WS 전파 | 5초 내 close, 후속 HTTP 401 |
| TR-SEC-05 | 안전한 입력 표시 | 합성 script·위험 링크 실행 0 |
| TR-SEC-06 | HTTP/WS schema 및 크기 제한 | 잘못된 입력 저장 없이 거절 |
| TR-SEC-07 | tailnet 전용 노출 | loopback 외 listener·Funnel·공개 port 없음 |
| TR-SEC-08 | 사용자 본문 지속 캐시 금지 | Cache API/IndexedDB/localStorage에 본문·인증 응답 없음 |
| TR-SEC-09 | 개인정보 없는 계측 allowlist | 허용목록 외 필드 0; 계측 실패가 메시지 처리를 막지 않음 |
| TR-SEC-10 | 백업/복원 경계 | 별도 승인·격리 복원 대조; shared-infra 변경 없음 |

위 표는 설계 제안이며 보안 감사나 구현 검증 결과가 아닙니다. 코드, DB, .env, 인증정보, shared-infra에 접근하지 않았습니다.

## 6. Tailscale Serve와 PWA

Tailscale Serve HTTPS는 tailnet에서 로컬 reverse proxy로 제안합니다. 앱은 127.0.0.1:<port>만 listen합니다. 운영 명령은 설치된 CLI help/status로 확인해 runbook에 고정합니다. Funnel은 인터넷 공개이므로 사용하지 않습니다. router port forwarding, LAN bind, 0.0.0.0 listener 금지. Serve hostname은 비밀이 아니므로 앱 인증을 유지하고, Mac sleep/offline은 명시적으로 표시합니다. DB port는 Serve하지 않습니다.

PWA manifest는 승인된 배포 이름, start_url=/, scope=/, display=standalone, 독자 제작 192/512 아이콘을 둡니다. service worker는 해시된 app shell 정적 파일만 캐시하고 /api/**, 메시지·읽음·인증·초대 응답과 WS를 우회합니다. 본문은 Cache API·IndexedDB·localStorage에 저장하지 않고 화면 메모리에서만 일시 보유합니다. 오프라인 발신 큐 없음; server ACK 전 성공 표시 없음; 로그아웃 시 화면 데이터를 비웁니다. 640px 이하에서 공간→대화→스레드 단일 화면, 뒤로가기·focus 복구, 가상 키보드 대응, IME Enter 방지를 지원합니다. iOS Safari별 설치·cookie·WS는 QA 확인 대상입니다. PWA가 Push/offline messaging을 약속하지 않습니다.

## 7. NFR·운영

| ID | 미측정 제안 목표 |
|---|---|
| NFR-01 | seq/sync_cursor는 동시 생성·수정·삭제에서도 유일·단조 증가 |
| NFR-02 | 같은 client_message_id/payload 3회에도 메시지 1개; 다른 payload는 충돌 |
| NFR-03 | 60초 단절에 100개 생성과 기존 edit/delete 후 최종 상태 동일, 누락/중복 0 |
| NFR-04 | 10,000개 합성 이력 cursor paging에서 경계 누락/중복 0 |
| NFR-05 | 20 연결·5 msg/s·10분에서 commit→열린 기기 표시 p95 ≤ 1초 목표 |
| NFR-06 | 열린 기기 읽음 배지 2초 내 일치, 오래된 cursor로 후퇴 없음 |
| NFR-07 | 모바일 5분 복귀 시 동기화 전에 stale UI를 최신으로 표시하지 않음 |
| NFR-08 | 개인용 가용성은 Mac·전원·tailnet에 종속; 공용 SLA 없음 |

계측은 로컬 허용목록만 사용합니다: message_send_result(outcome enum, conv_kind enum, has_thread, latency bucket), sync_result(trigger/outcome enum, caught_up_count bucket, duration bucket), read_sync_result(outcome, duration bucket), auth_denied(action/reason enum), client_state(state enum). PII·본문·식별자·IP·UA·raw error를 금지하며 합성 부하 결과는 환경·실패율과 함께 별도 기록합니다.

SQL migration은 순서형 파일로 관리하고 시작 시 암묵 변경하지 않습니다. 백업은 승인된 shared-infra 절차를 변경 없이 사용하는 안이며 이번에 실행하지 않았습니다. 복원은 격리 DB에서 message 수, edit/delete 상태, DM membership, seq/sync cursor, read cursor를 대조합니다. 백업 보존·삭제 본문의 과거 사본 제거·RPO/RTO·복구 책임자는 결정 필요입니다.

## 8. 사실 / 추정 / 확인 필요

**사실:** Round 2 브리프에서 개인 tailnet, PostgreSQL 원장 다기기, 웹+PWA, Redis 미사용을 확정했습니다. Sol PRD R1은 실제 계정 1명, FR-AUTH-06, FR-SYNC-06/07, FR-CLIENT-07 및 FR-CLIENT-04 P0를 명시합니다. 설치 기록은 Node 26.12.1/pnpm 10.30.2입니다. Opus 개발설계서 R1은 3개 패키지, assertAccess 단일 경계, /api/sync?since= 및 read.updated를 가정합니다.

**설계 추론:** seq와 sync cursor 분리는 기존 메시지의 수정·삭제를 기기 복귀 후 재생하게 합니다. 단일 DB/서버는 개인용 조건에 맞고 Redis 없이 복구를 처리할 수 있습니다. 정적 shell 외 본문 비캐시는 서버 원장 원칙에 맞습니다.

**확인 필요:** PostgreSQL 실제 버전·접속 경계, package lock/runtime 버전, 첫 관리자 복구, Serve/ACL 실제 설정, 백업 보존·삭제, 브라우저별 PWA 지원. 코드·DB·.env·Tailscale 설정을 확인하거나 변경하지 않았습니다.

## 9. 공식 출처

공식 문서만 링크했습니다. robots.txt와 이용 약관은 확인하지 않았으므로 외부 공개 전 확인이 필요합니다.

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
| R1 초안 | 2026-11-07 | 확정 결정, Sol PRD v1.1, Opus 개발설계서 R1과 맞춘 시스템·DB·HTTP/WS·sync·보안·Tailscale·PWA·NFR·운영 제안 |

