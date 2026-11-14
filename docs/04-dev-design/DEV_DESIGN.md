상태: R3 최종안(개정 R3.3, 2026-11-08 ADR-001 채택) / 작성자: Claude-Opus 5.5 (pubkey `7484092c…`) / 입력: `docs/00-research/BUZZ_ROUND3_FINAL.md` §1–3, `docs/02-prd/PRD.md`(GPT-Sol R3, v1.2), `docs/03-trd/TRD.md`(GPT-Luna R3), `docs/05-design-ref/DESIGN_REFERENCE.md`(작성 시점 R1 v0.1 — Claude-Fable R3 병렬 작성 중), R2 리뷰 `docs/06-reviews/{GPT-Sol,GPT-Luna,Claude-Fable}.md`, `CLEANROOM.md`, `~/.claude/rules/verification.md`(브라우저 도구 지시), `~/Work/shared-infra/README.md`(PostgreSQL·`backup.sh`)

# 개발설계서 — ohmyslack (내부 코드명)

- 최종 채택: 영환님. 이 문서는 개발 방법의 제안입니다. 코드 작성·설치·Git·DB 접속·테스트 실행은 하지 않았습니다.
- **정본 범위(R3 브리프 §2):** 이 문서는 저장소 구조·단계 게이트·WBS·FR→테스트 매핑·CI 명령·테스트 DB의 정본입니다. FR ID·수용 기준은 PRD, 테이블·API·WS·커서·인증·상태 코드·TR-SEC·수치는 TRD, 토큰·브레이크포인트·폭·컴포넌트명·상태 문구·키맵·IME·아이콘은 디자인 레퍼런스가 정본입니다. 이 문서는 그 값을 새로 정하지 않고 "정본: <문서> §절"로 인용합니다.
- **디자인 레퍼런스 인용 방식:** 작성 시점에 디자인 레퍼런스는 R1이고 R3가 병렬로 작성 중입니다. 그래서 구간 값·폭·컴포넌트명은 이 문서에 복제하지 않고 §번호로만 인용합니다. 테스트는 코드의 토큰 모듈 상수(디자인 정본에서 옮긴 값)를 읽습니다(10절 A5).

## 0. 용어 — "P0"가 두 가지 뜻입니다

| 표기 | 뜻 | 정의한 곳 |
|---|---|---|
| **단계 P0–P4** | 개발 단계(준비 → MVP → v1 → Electron → export 가져오기) | 브리프 0절, 이 문서 3절 |
| **우선순위 P0/P1/P2** | FR의 기능 우선순위(P0 = MVP 필수) | PRD §7, PRD §11 정본·변경 관리 계약 5 |

**우선순위 P0 FR은 단계 P1(MVP)에서 출시합니다.** 이 문서에서 단계는 항상 "단계 P1"처럼, 우선순위는 "P0 FR"처럼 씁니다. 게이트는 `G0–G4`(단계 종료 게이트)로 따로 부릅니다. FR이 아닌 운영 검증 항목은 `BOOT-01`처럼 별도 ID를 씁니다(P0 FR 수 42는 그대로).

## 1. 결론

1. **구조:** pnpm 모노레포 `apps/web`(React+Vite PWA)·`apps/server`(Fastify HTTP+WS 단일 프로세스)·`packages/shared`(zod 계약) 3개 패키지입니다. 서버는 도메인 모듈 9개(auth·conversations·messages·sync·realtime·ops, R3.3 추가 bots·attachments·push)로 나눕니다. 모든 라우트와 WS 동작은 **접근 메타(`access`)를 필수로 선언**하고, 대화 단위 접근은 `conversations.service.assertAccess` 하나로만 통과합니다(B2).
2. **진행:** 단계 P1은 세로 slice 6개로 나눠 TDD로 쌓습니다. G1은 PRD v1.3의 P0 FR 42개 각각에 대해 **지정 테스트 1개 + 필수 보조 증거**가 모두 통과해야 열립니다(6절). `check:fr-coverage`는 PR 게이트에서는 진행 모드, G1에서는 판정 모드로 돌립니다(5-1).
3. **R3에서 바뀐 핵심:** 동기화는 TRD의 계정 전역 `change_id` 커서로 맞췄습니다(2-3). 초기 owner 생성 운영 증거 `BOOT-01`을 G1 선행 조건으로 넣었습니다(PRD §7-7). `check:cleanroom`은 grep 종료 코드를 분기해 실행 오류를 실패로 처리합니다(5-1).
4. **먼저 정해 주셔야 할 것(⚖️, 9절):** ① 통합 테스트 DB를 어디에 둘지 ② 브라우저 자동 E2E 공백을 수동 QA로 메울지 ③ CI 실행 위치.

## 2. 모노레포 구조

### 2-1. 디렉터리 (가정: 패키지 관리자 pnpm 10.30.2, 워크스페이스)

```text
ohmyslack/
├─ apps/
│  ├─ server/                 # Fastify: HTTP API + WebSocket, 단일 프로세스
│  │  ├─ src/
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/          # 초대·로그인·세션·비활성화·출처/CSRF 검증·로그인 제한
│  │  │  │  ├─ conversations/ # 채널·DM·멤버십·접근 검사(유일 진입점)
│  │  │  │  ├─ messages/      # 전송(멱등·seq)·이력·답글·수정/삭제·멘션
│  │  │  │  ├─ sync/          # 전역 change 커서 catch-up·snapshot·읽음 병합·unread 집계
│  │  │  │  ├─ realtime/      # WS 게이트웨이·구독 replay·팬아웃(메모리)
│  │  │  │  ├─ ops/           # health·로그 마스킹·계측 허용 목록·라우트 접근 레지스트리
│  │  │  │  ├─ bots/          # 봇 계정·토큰·봇 리스너 조립(R3.3, 정본: TRD §5-2, B9)
│  │  │  │  ├─ attachments/   # 첨부 메타데이터·바이트(R3.3, 정본: TRD §6-1, B10)
│  │  │  │  └─ push/          # Web Push 구독·전송(R3.3, 정본: TRD §6-2)
│  │  │  ├─ db/               # 연결 풀·트랜잭션 헬퍼(쿼리 계층 세부는 TRD 범위 밖, 착수 시 결정)
│  │  │  ├─ app.ts            # 플러그인 등록·라우트 조립
│  │  │  └─ main.ts           # 127.0.0.1 바인드·기동
│  │  ├─ bin/
│  │  │  ├─ bootstrap-owner.ts # 로컬 전용 최초 owner 생성 명령(정본: TRD §5, 5절 BOOT-01)
│  │  │  ├─ bot-admin.ts       # 로컬 전용 봇 계정·토큰 create/rotate/revoke/list(R3.3, 정본: TRD §5-2)
│  │  │  └─ vapid-keygen.ts    # 로컬 전용 VAPID 키쌍 생성(R3.3, 정본: TRD §6-2)
│  │  ├─ migrations/          # 순서형 SQL: NNNN_<설명>.sql (DDL 정본: TRD §2)
│  │  └─ test/                # **/*.int.test.ts (실DB) / **/*.unit.test.ts
│  └─ web/                    # React + TypeScript + Vite, PWA
│     ├─ src/
│     │  ├─ features/
│     │  │  ├─ auth/  ├─ sidebar/  ├─ conversation/   # 타임라인·작성기·attachments/(첨부 표시, R3.3)
│     │  │  ├─ thread/  ├─ sync/   # WS 클라이언트·catch-up·가시성 복귀·checkpoint.ts
│     │  │  └─ pwa/                 # manifest·sw.ts·설치 안내
│     │  ├─ ui/               # 디자인 토큰 모듈·공통 컴포넌트(정본: 디자인 레퍼런스 §3·§6)
│     │  └─ main.tsx
│     ├─ public/
│     │  ├─ icons/            # 독자 제작 심볼 source.svg + 아이콘 세트(정본: 디자인 §9)
│     │  ├─ fonts/            # 폰트 공식 웹 빌드 무수정 배치(정본: 디자인 §3-1, 서브셋 금지)
│     │  └─ manifest.webmanifest
│     └─ test/                # **/*.test.ts(x) (컴포넌트·로직)
├─ packages/
│  └─ shared/                 # zod 스키마: API DTO·WS 이벤트·오류 코드·ID 타입
├─ e2e/                       # 프로토콜 E2E: Node 클라이언트 2–3개로 다기기 모사(브라우저 없음)
├─ perf/                      # FR-SYNC-01 부하·지연 측정(단계 게이트 전용)
├─ qa/
│  └─ manual/                 # 수동 체크리스트·증거: QA-<FR ID>.md, QA-BOOT-01.md
├─ tools/                     # check-cleanroom·check-fr-coverage·check-log-leak·check-no-persist-cache·check-design-tokens·restore-drill
│  └─ test/                   # 검사기 자체 테스트(위반·정상·실행 오류 fixture)
├─ integrations/
│  └─ hermes-plugin/          # Hermes 어댑터(Python, R3.3·ADR-001 D-6). pnpm 워크스페이스 밖, check:fr-coverage 탐색 밖
└─ docs/
   └─ runbooks/               # BOOTSTRAP_OWNER.md·TAILSCALE_SERVE.md·RESTORE_DRILL.md
```

- **패키지는 3개만 둡니다(YAGNI).** DB 계층을 별도 패키지로 빼지 않습니다. 서버만 DB를 씁니다. 공용 설정(tsconfig·eslint)은 루트 파일로 둡니다.
- **`integrations/hermes-plugin/`(R3.3):** Python 어댑터 소스이며 pnpm 워크스페이스·`pnpm verify`·`check:fr-coverage` 탐색 범위 밖입니다. 배포(`~/.hermes/plugins/` 복사·링크)와 게이트웨이 재시작은 영환님이 합니다(ADR-001 D-6). 어댑터 측 동작은 수동 증거 `QA-FR-BOT-04`·`QA-FR-BOT-06`으로 판정합니다(5-1).
- **파일 크기:** 함수 50줄·파일 800줄·중첩 4단계 이내, 파일 200–400줄 권장(영환님 전역 규칙).
- **테스트 경로 정본:** 6절 표의 모든 경로는 저장소 루트 기준 전체 경로(`apps/server/test/…`, `apps/web/test/…`, `e2e/…`, `perf/…`, `tools/test/…`)로 씁니다. `check:fr-coverage`의 탐색 범위도 이 다섯 곳입니다.

### 2-2. 모듈 경계 규칙

| # | 규칙 | 이유 | 기계 검증 |
|---|---|---|---|
| B1 | 서버 모듈은 `routes → service → repo` 한 방향만 호출합니다. 다른 모듈의 `repo`를 직접 부르지 않고, 그 모듈의 `service`만 부릅니다. | 접근 검사 우회 경로 차단 | eslint `no-restricted-imports`(`**/modules/*/repo*`는 같은 모듈에서만) |
| B2 | **모든 HTTP 라우트와 WS 동작은 `access` 메타를 필수로 선언합니다.** 값은 `public`·`account`·`admin`·`conversation`·`message`·`attachment`·`bot` 중 하나입니다(정의는 2-4, `attachment`·`bot`은 R3.3). `conversation`·`message` 메타의 처리기는 대화를 해석한 뒤 `conversations.service.assertAccess(userId, conversationId, action)` **하나**로만 접근을 판정합니다. `message` 메타는 `messages.service`가 메시지 ID(또는 원문 ID)로, `attachment` 메타는 `attachments` 서비스가 첨부 ID로 대화를 해석해 같은 함수를 호출합니다. | FR-CONV-04, TR-SEC-01 | 레지스트리 테스트(6절 FR-CONV-04): Fastify `onRoute` 훅과 WS 동작 표에서 **전체** 목록을 수집하고, 메타 누락 1건이라도 있으면 실패. 수집 기준은 경로 변수 이름이 아니라 등록된 전체 라우트입니다 |
| B3 | `realtime`은 DB 커밋 **후** 서비스가 내는 도메인 이벤트만 구독합니다. 커밋 전 전송은 금지입니다. | FR-MSG-02(커밋 후 저장 확인), TRD §2 | 통합 테스트: 롤백된 트랜잭션은 WS 이벤트 0건 |
| B4 | WS는 알림 경로이고 진실의 원천은 DB입니다. 클라이언트는 재접속·전경 복귀 때마다 서버 전역 커서로 따라잡습니다(정본: TRD §4). | FR-SYNC-02/07 | E2E: 이벤트를 고의로 유실시켜도 수렴 |
| B5 | `packages/shared`의 zod 스키마가 API·WS 계약의 단일 코드 정의입니다. 필드 이름·형태는 TRD §3–4를 옮긴 것이고, 서버는 입력을 경계에서 검증하고 웹은 수신 이벤트를 같은 스키마로 파싱합니다. JSON 필드는 `snake_case`, 라우트 변수·TS 식별자는 `camelCase`이며 변환은 `shared`의 스키마 경계에서만 합니다. | 경계 입력 검증, 계약 드리프트 방지 | `tsc --noEmit` 전 패키지 + 스키마 단위 테스트 |
| B6 | 로그는 `ops` 모듈의 로거만 씁니다. 로거는 허용 필드 목록 밖의 값을 버립니다(정본: PRD §10). 본문·자격 증명·토큰·쿠키·식별 ID는 직렬화 단계에서 제거합니다. | FR-OPS-03, TR-SEC-09 | 카나리아 문자열 로그 grep(6절) |
| B7 | 웹은 대화 본문·인증 응답을 Cache Storage·IndexedDB·localStorage·sessionStorage에 넣지 않습니다. 예외는 두 파일뿐입니다: `features/pwa/sw.ts`(Cache Storage에 해시된 앱 셸 정적 자원만), `features/sync/checkpoint.ts`(localStorage에 **숫자 sync checkpoint만** — 근거 TRD:103). | FR-CLIENT-04, TR-SEC-08 | `check:no-persist-cache`(5-1 정의) |
| B8 | 웹 기능 폴더끼리는 `index.ts` 공개 API로만 참조합니다. | 결합도 제한 | eslint import 규칙 |
| B9 | 봇 리스너는 별도 Fastify 인스턴스로 `/api/bot/v1/**`만 등록하며 서비스 계층(`assertAccess` 포함)은 사람 라우트와 공유합니다. 메인 리스너는 `Authorization` 헤더를 읽지 않습니다(R3.3, 정본: TRD §5-2). | 봇 토큰 경계, 접근 검사 단일화 | FR-BOT-02 지정 테스트·보조 `bot-listener-bind.int.test.ts`(루프백 전용·`/api/bot/v1/**` 외 404), FR-CONV-04 레지스트리에 봇 리스너 포함 |
| B10 | 첨부 바이트는 `attachments` 모듈만 읽고 씁니다. 다른 모듈은 메타데이터만 참조합니다(R3.3, 정본: TRD §6-1). 문서·텍스트 판정기도 `attachments` 모듈 안에 두며 서버 어디서도 압축 해제·XML 파싱·변환은 0입니다(R3.5, TRD §6-1-1). | 형식 판정·응답 헤더·보존 삭제를 한 곳에서 보장 | FR-OPS-05 지정 테스트·보조 `attachment-headers.int.test.ts` |

### 2-3. 요청 흐름 (정본: TRD §3–4. 아래는 구현 순서 요약이며 필드를 새로 정하지 않습니다)

1. **전송:** `POST /api/conversations/{id}/messages {client_message_id, body, thread_root_id?}` → `assertAccess` → 단일 트랜잭션(대화 행 잠금 → `seq` 증가 → `messages`·`message_mentions` insert → `sync_clock` 행 갱신으로 전역 `change_id` 할당 → `conversation_changes` insert) → 커밋 → 응답(생성 메시지·`seq`·`change_id`) → 커밋 후 `message.created`를 참여자의 연결된 기기에 팬아웃합니다(본인 다른 기기 포함). 같은 키·같은 payload 재시도는 원래 결과, 다른 payload는 409입니다(TRD:66).
2. **따라잡기:** 클라이언트는 기기별 **전역 checkpoint 1개**(숫자)만 보관합니다. `GET /api/sync?after=<checkpoint>&limit=`의 첫 응답에서 `through_cursor`(watermark)를 받고, 후속 페이지는 `through=`로 같은 watermark까지만 읽습니다. 응답은 현재 상태로 접힌 메시지 projection이며, 적용 키는 `change_id`입니다. watermark에 도달해 catch-up이 끝난 뒤에만 checkpoint를 전진시킵니다(TRD:94, :101, :124).
3. **만료·새 기기:** 410이거나 checkpoint가 없으면 `GET /api/conversations` → 활성 대화별 `GET /api/sync/snapshot` → `snapshot_cursor` 이후 catch-up → 목록 재조회 순서로 초기화합니다. 이 절차가 끝날 때까지 UI는 최신으로 표시하지 않습니다(TRD:95, :103).
4. **구독:** catch-up 뒤 `conversation.subscribe {conversation_id, after_cursor}` → 서버가 listener 등록 후 `(after_cursor, through_cursor]` replay → `conversation.subscribed` ACK. live·replay 중복은 `change_id`로 제거합니다(TRD:113–114, :124).
5. **읽음:** `PUT /api/read-state {conversation_id, thread_root_id?, last_read_seq}` → 서버가 membership·root 유효성·실제 존재하는 최대 seq 이하인지 검사(범위 밖 400) → `max(기존, 요청)`으로만 갱신 → `read.updated {conversation_id, thread_root_id?, last_read_seq, updated_at}`를 같은 사용자의 다른 기기에 팬아웃합니다(TRD:70, :96, :118). 단절됐던 기기는 복귀 때 `GET /api/conversations`의 읽음 snapshot으로 수렴합니다(TRD:99, :124).

### 2-4. 접근 메타 정의와 대상 라우트 (B2의 매트릭스 입력)

라우트 목록 자체의 정본은 TRD §3–4입니다. 아래는 각 라우트에 붙일 메타와 매트릭스 검증 대상입니다. 기대 상태 코드는 TRD:105를 그대로 씁니다(비멤버의 대화 단위 자원 404, 참여자의 관리자·타인 메시지 쓰기 403, 미인증·비활성 401).

| `access` | 대화 해석 방법 | 해당 라우트·동작(TRD §3–4) | 매트릭스 검증 |
|---|---|---|---|
| `public` | — | `POST /api/auth/login`, `POST /api/invites/accept`, `GET /api/healthz` | 응답에 대화·멤버 정보 0건. `invites/accept`는 `member` 역할만 생성(owner 생성 경로 없음 — BOOT-01) |
| `account` | 대화 없음 또는 서버가 membership으로 필터 | `POST /api/auth/logout`, `GET /api/me`, `GET /api/sessions`, `DELETE /api/sessions/{id}`(R3.5, 1c), `GET /api/members`, `GET /api/conversations`, `GET /api/conversations/discover`, `POST /api/dms`, `GET /api/sync` | `/api/sync`: 비참여 대화의 변경이 payload에 0건(커서는 전진). `discover`: 미참여 공개 채널만, 메시지·멤버 정보 0건(PRD FR-CONV-04 예외는 이것뿐). `/api/conversations`: 나간·비참여 대화 0건 |
| `admin` | — | `POST /api/invites`, `POST /api/admin/members/{user_id}/deactivate`, `POST /api/conversations` | 일반 멤버 403, DB 변화 0 |
| `conversation` | 경로 `{id}`, 쿼리 `conversation_id`, 본문 `conversation_id` 중 선언한 위치 | `POST /api/conversations/{id}/join`·`DELETE …/membership`·`POST …/bots`·`DELETE …/bots/{bot_user_id}`(action `manage_bots`, P1 FR FR-BOT-08)·`GET …/members`·`GET …/messages`·`POST …/messages`, `GET /api/sync/snapshot`, `PUT /api/read-state`, WS `conversation.subscribe` | 비참여자·나간 사용자 404·이벤트 0·데이터 변화 0, 비활성 401. `join`은 공개 채널 비참여자가 허용 대상(DM은 404) |
| `message` | 메시지 ID·원문 ID → `messages.service`가 대화 해석 | `GET /api/messages/{root_id}/replies`, `PATCH /api/messages/{id}`, `DELETE /api/messages/{id}` | 비참여자 404, 참여 비작성자의 수정·삭제 403, 비활성 401 |
| `attachment` (R3.3) | 첨부 ID → `attachments` 서비스가 첨부의 대화 해석 → `assertAccess` | `GET /api/attachments/{id}`(Range 지원, 정본: TRD §6-1). 업로드 `POST /api/attachments?conversation_id=`는 `conversation` 메타 | 비참여자 404, 비활성 401 |
| `bot` (R3.3) | 봇 리스너 전용. Bearer 토큰 → 봇 계정, 대화 단위 동작은 같은 `assertAccess` | `/api/bot/v1/**` 전체와 WS `/api/bot/v1/ws`(목록 정본: TRD §5-2) | 봇은 참여 대화만(그 밖은 404·이벤트 0), 폐기·회전된 토큰 401, 봇 토큰으로 사람 API·사람 쿠키로 봇 API 401(FR-BOT-02·03) |

- 레지스트리 테스트는 위 표를 하드코딩하지 않습니다. 서버를 띄워 실제 등록된 라우트·WS 동작을 수집하고, ① 메타 누락 ② `conversation`·`message`·`attachment` 메타인데 `assertAccess` 호출 기록이 없는 처리기 ③ 매트릭스 행위자(비참여자 C·나간 사용자·비활성 계정·참여 비작성자, R3.3 추가 봇(참여 대화만)·폐기 토큰 봇) 기대 결과 불일치 중 하나라도 있으면 실패합니다. R3.3 메타 2종은 `apps/server/src/http/access.ts`의 union과 레지스트리 테스트를 같은 PR(W-18)에서 함께 고칩니다.
- TRD에 새 라우트가 추가되면 메타 선언 없이는 서버가 기동하지 않게 합니다(등록 헬퍼가 `access` 누락 시 throw).

## 3. 단계(P0–P4)와 종료 게이트

일정은 달력으로 제시하지 않습니다(합본 4절 정정 4). 각 WBS 항목에 상대 크기 S/M/L만 붙입니다.

| 단계 | 목표 | 종료 게이트 | 게이트 판정자 |
|---|---|---|---|
| **P0 준비** | 문서 4종 R3 채택, 저장소 골격·검사 도구, 테스트 DB 결정 | **G0(도구 smoke 게이트)**: ① PRD·TRD·개발설계서·디자인 레퍼런스 R3 최종안을 영환님이 채택 ② P0 FR ID 동결(이후 변경은 PRD 변경 이력 + 6-2 표 동시 수정, PRD §11 계약 1) ③ 빈 골격에서 `pnpm verify` 통과 — 이때 `check:fr-coverage`는 **진행 모드**라 P0 FR 전부 "미구현" 보고로 통과합니다(G0 당시 33개, R3.3 기준 42개) ④ 검사기 5종의 자체 테스트(위반·정상·실행 오류 fixture)가 Red→Green 확인 ⑤ 9절 ⚖️-1·2·3 결정 | 영환님(Jarvis 정리) |
| **P1 MVP** | P0 FR 42개 전부(v1.3: BOT 6·MSG-10·CLIENT-05·OPS-05 추가) | **G1(완전 FR 게이트)**: ① `pnpm check:fr-coverage --mode=gate` 통과 — 42개 FR 각각 지정 테스트 1개가 발견·실행·통과, skip/todo 0, 필수 보조 증거 통과, 수동 증거 PASS(5-1) ② `BOOT-01` 운영 증거 PASS(PRD §7-7) ③ 커버리지 80% 이상(⚖️-6 범위) ④ Security 리뷰 미해결 Critical·High 0건 ⑤ FR-SYNC-01 측정 결과 기록 ⑥ FR-OPS-02 격리 복원 대조 통과 ⑦ FR-OPS-01 노출 경계 점검 통과 ⑧ PRD §9 파일럿 3개 업무일, 누출·유실·중복 0건 ⑨ Hermes 단계 H1–H3(ADR-001 §7) 테스트 증거와 `QA-FR-BOT-04`·`QA-FR-BOT-06` PASS | QA(검증) → Jarvis → 영환님 |
| **P2 v1** | P1 FR(기기 세션 목록·비공개 채널·일반 파일(FR-OPS-09)·검색·presence·봇 채널 참여(FR-BOT-08–11)) 중 영환님이 고른 것. 최소 첨부·Web Push는 R3.3에서 P1 MVP로 이동 | **G2**: 선택한 P1 FR의 테스트 매핑 추가·통과, 검색·파일은 권한 밖 결과 0건, G1 회귀 0건 | 동일 |
| **P3 Electron** | 웹 앱을 감싸는 데스크톱 셸 | **G3**: Electron 공식 보안 문서 기준 설정 확인 — `contextIsolation`·`sandbox` 켜짐, `nodeIntegration` 꺼짐, fuse `RunAsNode`·`EnableNodeOptionsEnvironmentVariable`·`EnableNodeCliInspectArguments` 꺼짐, `EnableEmbeddedAsarIntegrityValidation`·`OnlyLoadAppFromAsar` 켜짐. 확인은 **우리 패키지에만** REA `inspect_electron_fuses`로 합니다(CLEANROOM 6절). 우리 패키지 대상 CLEANROOM 5절 검사 0건 | 동일 + Security |
| **P4 선택** | 공식 export 파일 1회 가져오기 | **G4**: 별도 승인(약관 확인 포함) 뒤에만 착수합니다. 실시간 브리지·Slack API는 대상이 아닙니다 | 영환님 |

- fuse 이름은 Electron 공식 fuses 문서 표기를 따른다고 가정했습니다. 단계 P3 착수 때 그 시점 문서로 다시 확인합니다(확인 필요).
- **개발 중 적용 상태:** 단계 P1 동안 PR 게이트는 진행 모드로 돌고, 판정 모드는 G1 신청 때 QA가 깨끗한 체크아웃에서 1회 돌립니다. 진행 모드에서 통과해도 G1 통과를 뜻하지 않습니다.

## 4. WBS — 단계 P0·P1

역할은 Hermes 실행 역할 기준입니다. **결과는 모든 역할이 Jarvis에게만 반환합니다.** 역할 간 전달(Designer→Developer, Developer→Security·QA)도 Jarvis를 거칩니다. Git commit·push는 Jarvis 규칙을 따릅니다(브리프 1절: push는 Jarvis만).

- **Developer:** 구현과 **모든 자동 테스트 작성**(TDD)을 맡습니다.
- **QA:** 읽기 전용 독립 검증만 합니다. 테스트를 쓰지 않고, 실행·재현·수동 체크리스트 수행·보고를 합니다.
- **Security(Orca):** 위협 모델·설계/코드 리뷰를 합니다. 인프라·설정을 직접 바꾸지 않습니다.
- **Designer:** 디자인 레퍼런스를 화면·컴포넌트·상태 명세와 독자 제작 에셋으로 바꿔 handoff합니다.

| ID | 작업 | 역할 | 선행 | 완료 조건 | FR | 크기 |
|---|---|---|---|---|---|---|
| W-01 | 모노레포 골격·tsconfig·eslint·vitest(JSON reporter 포함)·`pnpm verify`. Node·pnpm·PostgreSQL 버전은 TRD:35 절차대로 확인한 값으로 `.nvmrc`·`engines`·CI·lockfile에 함께 고정 | Developer | G0 ①② | 빈 골격에서 5-1 명령 전부 exit 0 | — | S |
| W-02 | 품질 스크립트 5종: `check:cleanroom`·`check:fr-coverage`·`check:log-leak`·`check:no-persist-cache`·`check:design-tokens`(정의는 5-1) | Developer | W-01 | 각 스크립트의 `tools/test/` 자체 테스트에서 위반 fixture exit 1·정상 fixture exit 0·실행 오류 fixture exit 1을 확인(Red 후 Green) | OPS-04, OPS-03, CLIENT-04 | M |
| W-03 | 위협 모델(자산·신뢰 경계: tailnet·Serve·쿠키·CSRF·WS·SW·checkpoint) | Security | TRD R3 | 6-3 TR-SEC 표의 테스트 후보를 검토해 누락을 Jarvis에 반환 | AUTH-06, OPS-01 | S |
| W-04 | 화면·컴포넌트 상태 명세(정본 구간별 단수·전송 상태·연결 상태·포커스 순서·S1/S3 화면 흐름) | Designer | DESIGN_REFERENCE R3 | 컴포넌트별 상태표·키보드 순서·구간·클린룸 출처 표기. 이름·문구는 정본 그대로 | CLIENT-01/02/07, MSG-02 | M |
| W-04b | **독자 제작 에셋:** 앱 심볼 `apps/web/public/icons/source.svg`·아이콘 세트·favicon(목록 정본: 디자인 §9), 폰트 공식 웹 빌드 무수정 배치(정본: 디자인 §3-1 — 자체 서브셋은 OFL Modified Version이라 ADR 없이는 금지) | Designer(에셋)·Developer(빌드 연결) | W-04 | 정본 목록의 파일이 모두 존재, PR 본문에 "독자 제작, 참고 출처 없음"(CLEANROOM 4-1), `check:design-tokens`·QA-FR-OPS-04 출처 검토 통과 | CLIENT-03, OPS-04 | S |
| W-05 | 마이그레이션 0001: TRD §2 테이블·제약·인덱스 전부 | Developer | TRD R3, ⚖️-1 | 빈 테스트 DB에 적용, 재실행 시 이미 적용된 파일은 건너뜀. 제약 위반 fixture(교차 대화 root·답글의 답글·DM 쌍 중복·채널명 정규화 중복)가 DB에서 거부됨. 실DB(`ohmyslack`) 미사용 | (기반) | M |
| W-05b | **초기 owner 생성(BOOT-01):** `apps/server/bin/bootstrap-owner.ts`(로컬 전용, 비노출 credential 입력) + `docs/runbooks/BOOTSTRAP_OWNER.md` | Developer(구현·런북)·Security(검토) | W-05 | `BOOT-01` 통합 테스트 통과 + 합성 환경에서 런북 1회 실행 증거 `qa/manual/QA-BOOT-01.md`(5-4) | (AUTH-01 선행) | S |
| W-06 | **Slice A — 인증:** 초대·로그인·로그아웃·세션(정본 TRD §5)·비활성화·관리자 가드·Origin/CSRF 검증·로그인 제한 | Developer | W-05b | 6-2 AUTH-01·02·03·05·06 지정 테스트·보조 증거 통과 | AUTH-* | L |
| W-07 | **Slice B — 대화 공간:** 채널 생성·discover·참여·나가기, DM 시작, 멤버 목록, 접근 레지스트리·`assertAccess` | Developer | W-06 | CONV-01–04 통과, 2-4 레지스트리 매트릭스 통과 | CONV-* | M |
| W-08 | **Slice C — 메시지:** 멱등 전송·seq·원문 이력·답글 이력·수정/삭제(tombstone)·멘션·안전 렌더·상한 | Developer | W-07 | MSG-01·03–07 통과 | MSG-* | L |
| W-09 | **Slice D — 실시간·동기화:** WS 게이트웨이·구독 replay·팬아웃·전역 커서 catch-up·snapshot/410·읽음 병합·unread/스레드 대상 집계 | Developer | W-08 | SYNC-02–06 통과, B3·B4 테스트 통과 | SYNC-* | L |
| W-10 | **Slice E — 웹 UI:** 정본 구간별 레이아웃·작성기(IME·전송 상태)·스레드 패널·키보드·접근성·폰트 연결 | Developer | W-04, W-04b, W-09 | MSG-02·08, CLIENT-01·02·07 컴포넌트 테스트 통과 | CLIENT-*, MSG-02/08 | L |
| W-11 | **Slice F — PWA·모바일 재개:** manifest·아이콘 연결·SW(앱 셸만)·checkpoint·가시성 복귀 동기화·연결 상태 표시 | Developer | W-10 | CLIENT-03·04, SYNC-07 자동 테스트 통과 | CLIENT-03/04, SYNC-07 | M |
| W-12 | Tailscale Serve 노출 런북(127.0.0.1 바인드·Serve HTTPS·Funnel 금지·DB 포트 비노출, 정본 TRD §6)·맥 상시 구동 방식 문서화 | Developer(문서)·Security(검토) | W-06, ⚖️-5 | `docs/runbooks/TAILSCALE_SERVE.md` + Security 검토 의견. 실제 Serve 설정 변경은 영환님 승인 후 | OPS-01 | S |
| W-13 | 백업·격리 복원 드릴 스크립트(공용 `backup.sh` 무수정, 복원 대상은 승인된 임시 DB) | Developer | W-09, ⚖️-4 | 합성 데이터로 대조 항목(TRD:181) 일치 | OPS-02 | M |
| W-14 | 지연 측정 도구: 부하 생성기(20연결·5msg/s·10분) + 같은 시계 표시 지연 수집(6-2 FR-SYNC-01 보조 증거) | Developer | W-10 | p50/p95·실패율·표본 수·환경 기록 형식 확정 | SYNC-01 | M |
| W-15 | Security 리뷰: 인증·세션·CSRF·WS Origin·IDOR(2-4 매트릭스)·XSS·checkpoint 저장·로그 누출 | Security | W-06–W-11, W-18–W-23(G1 P0 FR 42개 반영) | Critical/High 0건 또는 Jarvis에 수정 지시 반환 | AUTH-06, CONV-04, MSG-01, OPS-03 | M |
| W-16 | QA 독립 검증: 깨끗한 체크아웃에서 `pnpm verify` + `check:fr-coverage --mode=gate` 재실행, `qa/manual` 체크리스트 수행(맥 Safari/Chrome, 다른 맥, iPhone Safari·PWA) | QA | W-11–W-15, W-18–W-23(G1 P0 FR 42개 반영) | FR별 증거(명령 출력·스크린샷·기기/버전) 보고서. 실행하지 않은 항목은 "미검증"으로 표시 | 6절 전체 | M |
| W-17 | 파일럿 3개 업무일(PRD §9) | 영환님·QA 기록 | W-16 통과 | 누출·유실·중복 0건, 실패 사례 기록 | S1–S6 | — |
| W-18 | **서버-봇(H1, ADR-001 §7):** 마이그레이션 `0002_bots.sql`(`users.kind`·`bot_tokens`), `modules/bots/`, 봇 리스너(루프백·`/api/bot/v1/**`만, B9)·WS Bearer handshake, `bin/bot-admin.ts`, shared DTO `author_kind`, access 메타 `bot`·`attachment`(2-4), 런북 `docs/runbooks/HERMES_BOT.md` | Developer | R3.3 정본 채택(ADR-001) | BOT-01·02·03·05 지정 테스트·보조 증거 통과, FR-CONV-04 접근 매트릭스에 봇 라우트·봇 리스너 포함, `pnpm verify` 통과 | BOT-01/02/03/05 | L |
| W-19 | **웹-봇 표시·서식(H1):** 봇 작성자 배지(CMP-26 `BotBadge`)·봇 DM 고정 표시, 서식 확장(굵게·인라인 코드·목록·제목, ADR-001 §3-f)·슬래시 원문 전송(컴포넌트 정본: 디자인 §6-2) | Developer | W-18(shared `author_kind`) | MSG-10·BOT-06(웹 측) 지정 테스트·보조 증거 + FR-MSG-01 회귀(XSS·스킴) 통과 | MSG-10, BOT-06 | M |
| W-20 | **Hermes 어댑터(H1, H2에서 첨부 송수신 확장):** `integrations/hermes-plugin/`(Python, ADR-001 D-6) — 연결·재연결 백오프·cursor 따라잡기·owner allowlist·자기 echo 무시·4,000 code point 분할·스레드=세션 매핑·승인 텍스트 명령(D-5)·밀린 메시지 처리 상한 15분(D-7). Hermes 본체 코드는 복사하지 않고 import만 | Developer | W-18 | 가짜 ohmyslack 서버 대상 pytest 통과, 결과를 `QA-FR-BOT-04`·`QA-FR-BOT-06` 수동 증거로 W-24에 전달(pytest는 `pnpm verify` 밖, 5-1). 배포·게이트웨이 재시작은 영환님 | BOT-04, BOT-06 | L |
| W-21 | **서버-첨부(H2):** 마이그레이션 `0003_attachments.sql`, `modules/attachments/`(B10), 메시지↔첨부 결속, 보존 삭제 작업 | Developer | W-18 | OPS-05 지정 테스트(허용목록·내용 판정·상한·권한·Range 206·보존 삭제)·보조 헤더 테스트 통과, 2-4 접근 매트릭스 갱신 | OPS-05 | L |
| W-22 | **웹-첨부(H2):** `features/conversation/attachments/`(CMP-27 `AttachmentList`·CMP-28 `AudioAttachment`·CMP-29 `ImageAttachment`, 이미지 업로드), SW 첨부 경로 우회 확인 | Developer | W-21 | OPS-05 보조 컴포넌트 테스트·`check:no-persist-cache` 통과, `QA-FR-OPS-05`(iPhone PWA mp3 재생)는 W-24 | OPS-05 | M |
| W-23 | **Web Push(H3, ADR-001 D-3):** 마이그레이션 `0004_push.sql`, `modules/push/`, `bin/vapid-keygen.ts`, 웹 구독 설정(CMP-30 `PushSettings`)·SW push 핸들러 | Developer | W-18, **선행 실기 시험: tailnet `*.ts.net` origin에서 iOS 홈 화면 PWA push 수신 확인(D-3, TRD §6-2 확인 필요 항목) — 실패 시 착수 전 Jarvis에 반환** | CLIENT-05 지정 테스트(본문 없는 payload·endpoint 허용목록·404/410 구독 삭제)·보조 SW 테스트 통과, `QA-FR-CLIENT-05`는 W-24 | CLIENT-05 | L |
| W-24 | **QA 병행 운영·전환 판정(H1–H4):** 수동 증거 `QA-FR-BOT-02`·`QA-FR-BOT-04`·`QA-FR-BOT-06`·`QA-FR-OPS-05`·`QA-FR-CLIENT-05`, 전환 기록 `qa/manual/QA-HERMES-CUTOVER.md`. 읽기 전용, 테스트 코드 미작성 | QA | W-20(H1)·W-22(H2)·W-23(H3) 머지 + 영환님의 어댑터 배포·게이트웨이 재시작 | ADR-001 §7 전환 기준 항목별 증거(7일 연속 브리핑 수신·유실 0·승인 왕복·푸시 수신). 실행하지 않은 항목은 "미검증" | BOT-*, OPS-05, CLIENT-05 | M |
| W-25 | **1a standalone 첨부(ADR-002 §3 1a):** 어댑터 standalone 전송 경로에서 첨부 업로드·결속, 실패는 파일마다 `warnings` | Developer | 전환 판정 + G1 | **구현 완료·미배포**(브랜치 `k002bill2/p2s1-standalone-attach`, `ec55851`·`cdde7f9`, 2026-11-13 기준 Codex 리뷰 중). 배포·게이트웨이 재시작은 영환님 | (BOT-05 보강) | S |
| W-26 | **1b-S1 서버 문서 판정기·저장(ADR-002 §3 1b):** `packages/shared` 문서 첨부 상수·스키마(`filename`·`has_macros`), `modules/attachments/` 문서·텍스트 판정기(B10), 415 하위 코드(TRD §3), 마이그레이션 `0005_attachment_documents.sql`, 다운로드 `attachment` 헤더, 드릴 합성 첨부·`check:log-leak` 파일명 카나리아 | Developer | W-25, TRD §6-1-1(R3.5·R3.6) | 6-6 FR-OPS-09 지정·보조 테스트 통과, 2-4 접근 매트릭스 유지, 드릴 측정 기록(TRD §6-1-1 (7)) | OPS-09 | L |
| W-27 | **1b-A1 어댑터 `send_document`·인바운드 문서:** `integrations/hermes-plugin/` — 25 MiB 업로드·`X-Attachment-Filename`, owner 문서만 Hermes 문서 캐시, `message.deleted` 시 캐시 삭제 | Developer | W-26 머지, W-25 | 어댑터 pytest(THREAT_MODEL TM-ATT-09–11 검증 열) 통과(`pnpm verify` 밖). 배포·게이트웨이 재시작은 영환님 | OPS-09 | M |
| W-28 | **1b-W1 웹 문서 표시:** CMP-32 `DocumentAttachment`·작성기 칩·`accept` 확장(UI_STATES §2-13, COPY_GAPS G-53–G-62) | Developer | W-26 shared 스키마 | UI-AC-01–11 컴포넌트 테스트 통과, `QA-FR-OPS-09`(iPhone PWA 저장·열기)는 QA | OPS-09 | M |
| W-29 | **1c 서버 기기 세션:** 마이그레이션 `0006_session_device_label.sql`, 로그인 시 라벨 생성(TRD §5-3 표), `GET /api/sessions` 응답 변경, `DELETE /api/sessions/{id}`(2-4 매트릭스 `account`) | Developer | W-25(1b와 병렬 가능) | 6-6 FR-AUTH-04 지정 테스트 통과, 접근 매트릭스에 새 라우트 포함 | AUTH-04 | S |
| W-30 | **1c 웹 로그인한 기기:** CMP-22 `SessionList`(`/settings/sessions`, UI_STATES §2-14, COPY_GAPS G-63–G-72) | Developer | W-29 shared 스키마 | UI-AC-12–20 컴포넌트 테스트 통과, 두 기기 실기 확인(UI-AC-19)은 QA | AUTH-04 | S |
| W-31 | **첨부 표시 순서(p2s1-attach-order, TRD R3.7):** 마이그레이션 `0007_attachment_bind_order.sql`(열 추가만), 결속 때 요청 위치 기록, projection 정렬 `bind_order NULLS LAST, created_at, id`, 작성기 칩 순서 테스트 고정 | Developer | W-28 | 통합 `apps/server/test/attachments/attachment-order.int.test.ts`·컴포넌트 `apps/web/test/conversation/attachments/composer-upload.test.tsx`(칩 순서 ≠ 완료 순서) 통과, `migrate-cli.int.test.ts` 0007 포함 | OPS-05 | S |

- **Slice 순서의 이유:** 초기 owner → 인증 → 접근 검사 → 메시지 → 동기화 → UI입니다. 보안 경계(FR-CONV-04)가 메시지 기능보다 먼저 서야, 이후 추가하는 모든 라우트가 처음부터 레지스트리 매트릭스에 걸립니다.
- **R3.3 Hermes 연동 순서(ADR-001 §7):** W-18 단독 선행 → W-19 ∥ W-20 ∥ W-21 병렬 → W-22·W-23 → W-24. H1 = W-18–W-20, H2 = W-21·W-22(+ W-20 첨부 확장), H3 = W-23, H4 전환 판정은 영환님.
- **Slice 완료 정의(PR 단위):** ① 해당 FR 지정 테스트를 먼저 쓰고 실패(Red)를 확인 ② 구현해 통과(Green) ③ 전 패키지 `pnpm verify` 통과(부분 패키지만 돌린 결과는 증거로 쓰지 않음) ④ 구현자 외 리뷰(QA 또는 Security) 1회 ⑤ PR 본문에 "참고 출처: <공개 문서 또는 '일반 관념'>" 1줄(CLEANROOM 4절).

## 5. 품질 게이트·CI 명령

### 5-1. PR 게이트 — `pnpm verify` (로컬·CI 동일)

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck                    # tsc --noEmit, 전 패키지
pnpm -r lint                         # eslint (B1·B7·B8 포함)
pnpm -r test --coverage              # vitest: unit + 컴포넌트, JSON 결과를 reports/에 기록
pnpm test:int                        # 서버 통합 + e2e/ 프로토콜 E2E, TEST_DATABASE_URL 필요
pnpm -r build
pnpm check:cleanroom                 # CLEANROOM.md 5절의 패턴·제외 목록을 읽어 실행(종료 코드 분기)
pnpm check:no-persist-cache          # B7
pnpm check:design-tokens             # 토큰 출처·대비 규칙(정본: 디자인 §2-3·§7-1)
pnpm check:fr-coverage --mode=progress
pnpm check:log-leak                  # test:int 로그에서 카나리아 문자열 0건
pnpm audit --prod --audit-level=high
```

**`check:cleanroom` (SOL-V1):**
- 패턴과 제외 디렉터리·파일 목록은 `CLEANROOM.md` 5절 코드 블록에서 읽습니다. 이 문서와 스크립트 본문에는 금지 문자열을 다시 적지 않습니다(복제하면 문서 자체가 검사에 걸리고 두 곳이 어긋남).
- 원문 한 줄(`… && exit 1 || echo CLEANROOM OK`)을 그대로 실행하지 않습니다. 같은 grep을 실행한 뒤 **종료 코드로 분기**합니다: `0` = 위반 발견 → 실패(exit 1), `1` = 일치 없음 → 통과(exit 0), `2` 이상·신호 종료·5절 블록 파싱 실패·대상 경로 없음 → 실행 오류 → 실패(exit 1, 원인 출력).
- 자체 테스트(`tools/test/check-cleanroom.test.ts`): 위반 fixture → 1, 정상 fixture → 0, 존재하지 않는 경로·읽기 권한 없는 파일·5절 블록 누락 → 1.
- CLEANROOM.md 원본은 수정하지 않습니다. 원문 한 줄의 오류 처리 한계는 10절 A7에 기록합니다.

**`check:no-persist-cache` (Fable D-3):**
1. eslint `no-restricted-globals`·`no-restricted-properties`로 `localStorage`·`sessionStorage`·`indexedDB`·`caches` 사용을 `apps/web/src/**`에서 금지합니다. 예외는 B7의 두 파일뿐입니다.
2. 단위 테스트: `sw.ts`가 `/api/**`·`/api/ws` 요청을 캐시 없이 통과시키는지, precache 목록에 해시된 정적 자원만 있는지 단언합니다. `checkpoint.ts`가 음이 아닌 정수 문자열 외 값을 저장하지 않고 로그아웃 때 지우는지 단언합니다.
3. 빌드 산출물 검사: `apps/web/dist`의 SW precache manifest에 `/api` 경로가 0건인지 봅니다.
- 스크립트는 1–3을 묶어 실행합니다. 실기기 저장소 확인은 `QA-FR-CLIENT-04`로 남깁니다(브라우저 없는 자동 검사로는 런타임 저장소를 볼 수 없음).

**`check:design-tokens` (Fable D-7, Should-fix 반영):** 토큰 모듈의 각 토큰에 출처·라이선스 필드가 있는지, 디자인 §2-3의 색 금지 규칙과 §7-1 대비 기준을 만족하는지 계산합니다. 규칙 값은 디자인 정본에서 옮긴 상수를 씁니다.

**`check:fr-coverage` (SOL-V4, Luna-1):**
- **입력 원천은 셋뿐입니다:** ① `docs/02-prd/PRD.md` FR 표에서 우선순위 열이 `P0`인 `FR-XXX-nn`(PRD §11 정본·변경 관리 계약 1의 5열 형식) ② 이 문서 6-2 표(형식은 6-2 머리에 고정) ③ 이 문서 6-3 TR-SEC 표(형식은 6-3 머리에 고정, THREAT_MODEL NC-01). 별도 매핑 사본(JSON 등)을 두지 않습니다.
- **6-3 판정:** 참조 행(`→ FR-…`)은 참조한 FR의 판정을 따릅니다(그 FR이 실패하면 해당 TR-SEC 행도 실패로 보고). 자체 지정 행은 6-2 행과 같은 규칙으로 판정합니다(진행 모드 미구현 보고, 판정 모드 발견·실행·통과 필수, "수동" 열 QA PASS). PRD P0 집합 대조는 6-2에만 적용하고, 6-3은 TRD TR-SEC ID 집합(01–15) 완전성을 대조합니다 — 누락·중복·초과 ID나 6-2에 없는 참조 FR은 스캐너 오류입니다.
- **공통 실패 조건(두 모드):** 표 파싱 실패·형식 불일치(스캐너 오류), PRD P0 집합 ≠ 6-2 FR 집합, 6-2·6-3의 지정 테스트 이름 중복, 같은 지정 테스트 이름이 저장소에 2개 이상, 지정 테스트가 `skip`·`todo`·`only` 상태, 발견된 지정 테스트의 실행 결과가 실패.
- **진행 모드(`--mode=progress`, PR 게이트):** 아직 없는 지정 테스트는 "미구현 n개"로 보고만 하고 통과시킵니다. TR-SEC 자체 지정 행은 `TR-SEC 지정 n개 / 미구현 m개` 별도 줄로 보고합니다. G0 빈 골격도 이 모드로 통과합니다.
- **판정 모드(`--mode=gate`, G1):** 위에 더해 ① 42개 지정 테스트와 6-3 자체 지정 테스트 전부 발견·실행·통과 ② 6-2 "필수 보조 증거" 열의 테스트 전부 통과 ③ "수동" 열이 있는 행은 `qa/manual/QA-<FR>.md`가 5-4 필수 필드를 갖추고 결과 `PASS` ④ `QA-BOOT-01.md` PASS — 하나라도 빠지면 실패합니다.
- 실행 결과는 vitest JSON reporter 출력(`reports/*.json`)에서 테스트 전체 이름으로 대조합니다. 탐색 범위는 2-1의 다섯 경로입니다.
- **어댑터 pytest(R3.3):** `integrations/hermes-plugin/`의 pytest는 `pnpm verify`에 넣지 않습니다(Python 툴체인을 PR 게이트에 추가하지 않음 — YAGNI). 탐색 범위 밖이라 지정 테스트가 될 수 없으므로, 어댑터 측 동작은 W-20 완료 기준과 6-2 "수동" 열 `QA-FR-BOT-04`·`QA-FR-BOT-06`(판정 `PASS`)으로 판정합니다.

**테스트 DB 안전장치 (Sol Should-fix 1 반영):**
- `test:int`는 `TEST_DATABASE_URL`의 DB 이름이 `_test`로 끝나지 않거나 호스트가 `127.0.0.1`·`localhost`가 아니면 즉시 실패합니다. 운영 DB `ohmyslack`에는 절대 접속하지 않습니다.
- 접미사 검사는 오접속 방어의 한 겹입니다. 두 번째 겹은 **전용 role**입니다: 테스트 role은 `ohmyslack_test`의 소유자이고 `ohmyslack`에 `CONNECT` 권한이 없습니다(⚖️-1 승인 시 생성).
- 실행마다 실행 ID별 스키마를 만들어 마이그레이션을 적용하고, 끝나면 그 스키마만 지웁니다. 다른 스키마·DB는 건드리지 않습니다.

### 5-2. CI (가정 — ⚖️-3)

- GitHub Actions(비공개 저장소 `k002bill2/ohmyslack`) 1개 job: Node는 TRD:35 절차로 고정한 버전, PostgreSQL 서비스 컨테이너는 **shared-infra 실제 운영 major와 같은 버전**입니다. shared-infra README 기준 15이며, TRD가 운영 버전을 착수 전 확인 항목으로 두었으므로(TRD:35, :189) W-01에서 확인한 값으로 고정합니다. `pnpm verify`만 실행합니다.
- 비공개 저장소의 Actions 사용량·과금 조건은 확인하지 않았습니다(확인 필요). Actions를 쓰지 않으면 같은 `pnpm verify`를 로컬 pre-push 게이트로 두고, QA가 W-16에서 깨끗한 체크아웃으로 다시 실행합니다.

### 5-3. 단계 게이트 전용 (PR마다 돌리지 않음)

| 명령/절차 | 대상 | 이유 |
|---|---|---|
| `pnpm check:fr-coverage --mode=gate` | G1 ① | 수동 증거·실기기 결과까지 요구 |
| `pnpm perf:latency` (10분) + 같은 시계 표시 지연 수집 | SYNC-01 | 시간이 길고 환경 의존 |
| `pnpm e2e:realgap` (실제 60초 단절 1회) | SYNC-02 | PR 게이트에서는 시간을 압축한 버전만 돌립니다 |
| `tools/restore-drill.sh` | OPS-02 | 임시 DB 생성이 shared-infra 작업이라 승인 필요 |
| `qa/manual/QA-*.md` | 6-2 "수동" 열, BOOT-01 | 실기기·실네트워크 필요 |

### 5-4. 수동 증거 파일 형식 (`qa/manual/QA-<ID>.md`)

필수 필드: 실행자 · 일시(KST) · 기기·OS·브라우저(버전) · 접속 경로(localhost / tailnet Serve HTTPS) · 절차(번호) · 기대 결과 · 실제 결과 · **판정(`PASS`/`FAIL`/`미검증`)** · 증거 경로(스크린샷·명령 출력). 필드가 비었거나 판정이 `PASS`가 아니면 판정 모드에서 실패합니다. 실행하지 않은 항목을 `PASS`로 적지 않습니다(8절 8).

## 6. 테스트 전략(TDD)과 P0 FR → 테스트 매핑

### 6-1. 계층

| 계층 | 도구(가정) | 대상 | 위치 |
|---|---|---|---|
| 단위 | vitest | 순수 로직: seq·커서 병합·멘션 파싱·렌더 정화·unread 계산·checkpoint | `apps/*/test/**/*.unit.test.ts` |
| 통합 | vitest + Fastify `inject` + 실제 PostgreSQL 테스트 DB + Node WS 클라이언트 | 라우트·트랜잭션·권한·WS 이벤트·서버 재기동 | `apps/server/test/**/*.int.test.ts` |
| 프로토콜 E2E | vitest + 서버 실기동 + Node HTTP/WS 클라이언트 2–3개(기기 A·B, 비참여자 C 모사) | 다기기·재접속·수렴 | `e2e/*.e2e.test.ts` |
| 컴포넌트 | vitest + Testing Library + jsdom | 작성기·IME 이벤트·키보드·상태 표시·배지·SW 라우팅 | `apps/web/test/**/*.test.tsx` |
| 부하·지연 | Node 스크립트 + 같은 시계 표시 지연 수집 | p95 측정 | `perf/` |
| 수동 | ego-browser(데스크톱 브라우저)·실기기(iPhone Safari/PWA) | 레이아웃·IME 실기·설치·페이지 복원·네트워크 경계 | `qa/manual/QA-<ID>.md` |

- **브라우저 자동 E2E는 두지 않습니다.** 근거는 영환님의 직접 지시입니다: `~/.claude/rules/verification.md` "브라우저 검증 도구 (2026-09-15 사용자 지시)" — Playwright·Puppeteer를 저장소는 물론 스크래치패드에도 설치하지 않으며 브라우저 런타임 검증은 ego-browser로만 합니다. 이 문서가 보수적으로 넓힌 해석이 아닙니다. 공백은 프로토콜 E2E(서버 계약)·컴포넌트 테스트(UI 로직)·QA의 ego-browser·실기기 체크리스트로 메웁니다. 규칙 예외 여부는 ⚖️-2에서 영환님만 정합니다.
- **jsdom의 한계:** 레이아웃 계산·실제 IME·SW 설치·bfcache 페이지 복원은 재현하지 못합니다. 그래서 해당 FR은 자동 테스트(이벤트·상태 로직)와 수동 체크(실기기)를 **둘 다** 통과해야 합니다.
- **Red-Green 규칙:** 버그 수정은 회귀 테스트로 ① 통과 ② 수정을 되돌려 실패 ③ 복원해 통과를 확인합니다(영환님 검증 규칙).
- **정본 수치를 복제하지 않습니다.** 상한·로그인 제한·세션 수명·보존 경계는 TRD §5 값을 `packages/shared`의 상수로 옮기고, 테스트는 그 상수를 읽어 상한/상한+1, 허용 횟수/초과 1회, 만료 전/후로 판정합니다(PRD §7-7). 구간·폭·아이콘 목록은 디자인 정본을 옮긴 토큰 모듈 상수를 읽습니다.

### 6-2. 매핑 표 — PRD v1.3 P0 FR 42개

**"1:1 매핑"의 뜻 (Luna Should-fix 1):** FR 1개에 **지정 테스트 1개**가 판정 기준입니다. 한 테스트 이름에 모든 수용 기준을 넣는다는 뜻이 아닙니다. 서버·UI·실기기 증거가 함께 필요한 FR은 "필수 보조 증거"와 "수동" 열에 적고, G1에서는 셋 다 통과해야 합니다. 보조 테스트는 이름 앞에 같은 FR ID를 붙이되 지정 테스트 이름과 겹치지 않게 씁니다.

**표 형식 계약:** 6열(FR / 지정 테스트 이름 / 계층·파일 / 실행 / 필수 보조 증거 / 수동) 순서와 백틱으로 감싼 이름·경로를 유지합니다. 바꾸면 `check:fr-coverage` 파서를 같은 PR에서 고칩니다. "실행" 열: **PR** = 5-1 PR 게이트, **G1** = 단계 게이트(5-3). 파일 경로는 저장소 루트 기준이며 컴포넌트 테스트 파일명은 디자인 정본 컴포넌트명이 확정되면 맞춰 바꿉니다(이름 바꿈은 지정 테스트 이름에 영향 없음).

| FR | 지정 테스트 이름 | 계층·파일 | 실행 | 필수 보조 증거 | 수동 |
|---|---|---|---|---|---|
| FR-AUTH-01 | `FR-AUTH-01 미가입자는 조회·구독이 거부되고 만료·사용 완료·폐기 초대는 계정을 만들지 않으며 동시 수락은 1회만 성공하고 수락 계정은 member다` | 통합 `apps/server/test/auth/invite.int.test.ts` | PR | `BOOT-01` 통과(선행) | — |
| FR-AUTH-02 | `FR-AUTH-02 로그인 세션은 새로고침 후 유지되고 잘못된 자격 증명은 거부되며 로그아웃 세션은 HTTP 401·WS 5초 내 종료이고 다른 기기 세션과 5분 뒤 유효 세션 복귀는 유지된다` | 통합 `apps/server/test/auth/session.int.test.ts` | PR | 컴포넌트 `apps/web/test/auth/session-expired.test.tsx`: 만료·폐기 세션의 401에서만 로그인 안내 | — |
| FR-AUTH-03 | `FR-AUTH-03 비활성화 후 5초 안에 열린 WS가 닫히고 이후 HTTP·재구독은 401이다` | 통합 `apps/server/test/auth/deactivate.int.test.ts` | PR | — | — |
| FR-AUTH-05 | `FR-AUTH-05 일반 멤버의 초대·비활성화·채널 생성 요청은 403이고 DB 상태가 바뀌지 않는다` | 통합 `apps/server/test/auth/admin-guard.int.test.ts` | PR | — | — |
| FR-AUTH-06 | `FR-AUTH-06 미인증 HTTP·WS와 외부 Origin·CSRF 불일치 상태 변경·WS 연결이 거부되고 로그인 제한은 TRD 상수 경계 전후에서 거부·복구되며 성공 시 카운터가 초기화된다` | 통합 `apps/server/test/auth/origin-ratelimit.int.test.ts`(가짜 시계) | PR | — | — |
| FR-CONV-01 | `FR-CONV-01 관리자만 공개 채널을 만들고 정규화 후 같은 이름은 거부되며 활성 멤버만 공개 채널 목록을 본다` | 통합 `apps/server/test/conversations/channels.int.test.ts` | PR | — | — |
| FR-CONV-02 | `FR-CONV-02 참여 후 이력·구독이 가능하고 나가면 이력·쓰기·구독이 거부되며 5초 안에 기존 구독이 끊기고 목록에 남아 재참여할 수 있다` | 통합 `apps/server/test/conversations/membership.int.test.ts` | PR | 같은 파일 보조: 재참여 시 이전 메시지가 새 unread가 되지 않음(TRD:70) | — |
| FR-CONV-03 | `FR-CONV-03 같은 멤버 쌍의 DM 시작은 순서·동시 요청과 무관하게 같은 DM ID를 반환한다` | 통합 `apps/server/test/conversations/dm.int.test.ts` | PR | — | — |
| FR-CONV-04 | `FR-CONV-04 접근 레지스트리의 모든 HTTP 라우트와 WS 동작에서 비참여자·나간 사용자는 내용·멤버십·이벤트 0건이고 데이터가 바뀌지 않으며 공개 채널 discover만 메시지·멤버 정보 없이 예외다` | 통합 `apps/server/test/conversations/access-matrix.int.test.ts`(2-4: 전체 라우트 수집, 메타 누락 시 실패) | PR | 같은 파일 보조: 비멤버 404·비활성 401·참여 비작성자 403(TRD:105), `/api/sync` payload 필터 | — |
| FR-MSG-01 | `FR-MSG-01 한글·줄바꿈·http/https 링크·코드 블록은 표시되고 raw HTML·스크립트·그 외 스킴은 실행되지 않는다` | 컴포넌트 `apps/web/test/conversation/render.test.tsx` | PR | 통합 `apps/server/test/messages/limits.int.test.ts`: 빈 메시지·상한+1 code point 저장 0, 상한은 저장(TRD §5 상수) | — |
| FR-MSG-02 | `FR-MSG-02 HTTP 저장 응답 전에는 저장 확인을 표시하지 않고 HTTP 오류는 실패와 재시도로 표시하며 연결 단절만으로 미저장을 단정하지 않고 자동 전송 큐를 만들지 않는다` | 컴포넌트 `apps/web/test/conversation/send-status.test.tsx`(문구 정본: 디자인 §6) | PR | 통합 `apps/server/test/messages/durability.int.test.ts`: 커밋 후에만 성공 응답, 주입한 롤백은 오류 응답·행 0·WS 0, 서버 앱 종료·재기동 후 확인된 본문 조회 | — |
| FR-MSG-03 | `FR-MSG-03 ACK 유실 후 같은 client_message_id·내용 3회는 메시지 1개이고 다른 내용은 409이며 다른 계정·대화와 결합되지 않는다` | 통합 `apps/server/test/messages/idempotency.int.test.ts` | PR | — | — |
| FR-MSG-04 | `FR-MSG-04 원문·답글 혼합 1만 건을 동시 전송 중 원문 이력을 페이지로 넘기면 누락·중복 0이고 답글은 페이지 크기를 쓰지 않으며 답글 이력은 스레드별로 같고 seq 간격을 유실로 보지 않는다` | 통합 `apps/server/test/messages/paging.int.test.ts` | PR | — | — |
| FR-MSG-05 | `FR-MSG-05 본인만 수정·삭제하고 참여 비작성자는 403·비참여자는 404이며 삭제 본문·멘션은 이력·답글·sync·WS 어디에도 다시 나오지 않고 답글은 남는다` | 통합 `apps/server/test/messages/edit-delete.int.test.ts` | PR | 같은 파일 보조: 삭제 전 커서부터 여러 페이지 sync 재생 시 삭제 본문 0회(TRD:68) | — |
| FR-MSG-06 | `FR-MSG-06 답글의 답글과 다른 대화 원문 답글은 거부되고 답글은 원문 이력에 섞이지 않으며 원문 삭제 후에도 남고 답글 수는 살아 있는 답글만 센다` | 통합 `apps/server/test/messages/thread.int.test.ts` | PR | — | — |
| FR-MSG-07 | `FR-MSG-07 멘션은 mention_user_ids의 참여자만 1회 집계되고 자기 멘션은 제외되며 수정 시 추가·제거되고 이미 읽은 메시지는 새 미읽음이 되지 않으며 읽음으로 해제된다` | 통합 `apps/server/test/messages/mention.int.test.ts` | PR | — | — |
| FR-MSG-08 | `FR-MSG-08 조합 중 Enter와 조합 확정 Enter는 전송하지 않고 확정 후 독립 Enter는 1회 전송하며 조합 중 입력이 훼손되지 않는다` | 컴포넌트 `apps/web/test/conversation/composer-ime.test.tsx`(6-4 사례 전부) | PR | — | `QA-FR-MSG-08`: macOS Safari·Chrome, iOS Safari·홈 화면 PWA 한글 실기(정본 매트릭스: 디자인 §7-4) |
| FR-MSG-10 | `FR-MSG-10 굵게·인라인 코드·목록·제목·http/https 마크다운 링크는 텍스트 노드로 표시되고 그 외 스킴과 닫히지 않은 기호는 원문 그대로이며 HTML을 만들지 않는다` | 컴포넌트 `apps/web/test/conversation/render-format.test.tsx` | PR | 단위 `apps/web/test/conversation/render-linear.test.ts`: 4,000자 최악 입력 선형 시간(F-1 회귀) | — |
| FR-SYNC-01 | `FR-SYNC-01 20연결·5msg/s·10분에서 커밋부터 다른 기기 화면 표시까지 p95가 1000ms 이하이고 오류율·환경이 기록된다` | 지연 `perf/latency.perf.ts` + 6-5 같은 시계 표시 측정 | G1 | 6-5 (a) 프로토콜 지연 결과와 (b) 표시 지연 결과를 둘 다 기록. 수신만으로 표시 통과를 주장하지 않음 | `QA-FR-SYNC-01`: 측정 환경·브라우저·기기 기록 |
| FR-SYNC-02 | `FR-SYNC-02 단절 중 두 대화 이상에서 100건 생성과 수정·삭제 후 복귀하면 전역 커서 catch-up과 실시간 수신 경합에서도 최종 본문·삭제·순서가 같고 누락·중복 0이다` | 프로토콜 E2E `e2e/reconnect.e2e.test.ts`(단절 시간 압축) | PR + G1 | 같은 파일 보조: 여러 페이지 watermark, 410 → snapshot 절차로 같은 결과(TRD:95, :103) | G1에서 실제 60초 단절 1회(`pnpm e2e:realgap`) |
| FR-SYNC-03 | `FR-SYNC-03 본문·스레드 읽음 위치가 따로 저장되고 스레드 대상은 원문·답글 작성·멘션 수신으로만 생기며 본문 열기만으로 답글이 읽음 처리되지 않고 다른 기기에서 같다` | 통합 `apps/server/test/sync/read-state.int.test.ts`(PRD §7-7 합성 A/B/C 6사례) | PR | 컴포넌트 `apps/web/test/sync/read-visibility.test.tsx`: 전경·열린 상태·누락 없이 표시된 위치만 읽음 요청, 백그라운드·미개봉·단순 페이지 로드는 요청 0 | — |
| FR-SYNC-04 | `FR-SYNC-04 기기 A가 본문·스레드 읽음을 저장하면 같은 계정 기기 B에 2초 안에 read.updated가 도착하고 본문·스레드·멘션 수가 일치하며 스레드 수는 본문 수에 더해지지 않는다` | 프로토콜 E2E `e2e/multi-device-read.e2e.test.ts` | PR | 컴포넌트 `apps/web/test/sidebar/badge-sync.test.tsx`: `read.updated` 수신 → 배지 갱신(배지 표현 정본: 디자인 §6) | `QA-FR-SYNC-04`: 맥·iPhone 동시 전경, S6 배지 갱신 |
| FR-SYNC-05 | `FR-SYNC-05 자기 메시지·삭제 메시지·자기 멘션은 본문·스레드 unread와 멘션 집계에서 빠지고 읽지 않은 메시지가 삭제되면 배지가 남지 않으며 재수신해도 중복 집계되지 않는다` | 통합 `apps/server/test/sync/unread-count.int.test.ts` | PR | — | — |
| FR-SYNC-06 | `FR-SYNC-06 오래된 읽음 위치가 늦게 도착해도 커서가 후퇴하지 않고 다른 대화·다른 스레드·실제 최대 seq 초과 위치는 400이며 최대 유효 위치로 수렴한다` | 통합 `apps/server/test/sync/read-merge.int.test.ts` | PR | — | — |
| FR-SYNC-07 | `FR-SYNC-07 전경 복귀 시 유효 세션 확인·재연결·커서 catch-up 후 100건과 수정·삭제·다른 기기 읽음을 반영하고 완료 전과 서버 불가 시에는 최신으로 표시하지 않는다` | 프로토콜 E2E `e2e/resume.e2e.test.ts` | PR | 컴포넌트 `apps/web/test/sync/resume-banner.test.tsx`: 가시성 복귀 → 확인 중 표시 → 완료 후 해제, 서버 불가 시 끊김 표시(문구 정본: 디자인 §6) | `QA-FR-SYNC-07`: iPhone PWA 5분 백그라운드 후 복귀 |
| FR-CLIENT-01 | `FR-CLIENT-01 디자인 정본의 wide와 medium 구간 각각에서 키보드만으로 공간 전환·전송·스레드 닫기를 하고 포커스가 원래 항목으로 돌아온다` | 컴포넌트 `apps/web/test/layout/keyboard.test.tsx`(키맵 정본: 디자인 §7-3) | PR | — | `QA-FR-CLIENT-01`: 데스크톱 실화면 두 구간(ego-browser) |
| FR-CLIENT-02 | `FR-CLIENT-02 디자인 정본의 모든 구간과 경계 전후 폭에서 정본 단수로 렌더되고 compact에서 공간 본문 스레드 뒤로 이동이 된다` | 컴포넌트 `apps/web/test/layout/responsive.test.tsx`(토큰 모듈의 구간 상수로 `matchMedia` 구성) | PR | — | `QA-FR-CLIENT-02`: 정본 §11 QA 폭 목록 전부 가로 넘침 0, iPhone 390px S2·S4·S6, 가상 키보드 가림 0 |
| FR-CLIENT-03 | `FR-CLIENT-03 manifest가 standalone·start_url·scope와 정본 아이콘 세트를 갖고 일반 웹 접근과 설치 안내가 동작한다` | 단위 `apps/web/test/pwa/manifest.test.ts`(아이콘 목록 정본: 디자인 §9) | PR | — | `QA-FR-CLIENT-03`: tailnet HTTPS에서 iOS 홈 화면 추가 → standalone 첫 로그인 → 재실행 시 유효 세션 유지 → S6 |
| FR-CLIENT-04 | `FR-CLIENT-04 SW·Cache Storage·IndexedDB·localStorage에 본문·인증 응답이 없고 숫자 checkpoint만 예외이며 API·WS는 SW를 우회하고 로그아웃 시 화면 본문 상태가 지워진다` | 컴포넌트 `apps/web/test/pwa/no-persist.test.ts` | PR | `pnpm check:no-persist-cache`(5-1 정의 1–3. R3.3: SW 우회 목록에 `/api/attachments/**` 포함 확인) | `QA-FR-CLIENT-04`: 실기 저장소 검사, 로그아웃 후 뒤로·앞으로·페이지 복원에서 본문 재노출 0 |
| FR-CLIENT-05 | `FR-CLIENT-05 구독 기기에 본문 없는 payload로 알림이 1건 전송되고 404·410 구독은 삭제되며 허용목록 밖 endpoint는 등록되지 않는다` | 통합 `apps/server/test/push/push.int.test.ts`(가짜 push service) | PR | 컴포넌트 `apps/web/test/pwa/push-handler.test.ts`: SW push 이벤트가 항상 알림을 표시하고 본문을 저장하지 않음 | `QA-FR-CLIENT-05`(iOS 16.4+ 홈 화면 PWA·tailnet origin 실기 수신) |
| FR-CLIENT-07 | `FR-CLIENT-07 주요 조작에 접근 가능한 이름과 가시 포커스가 있고 전송 실패·연결 상태를 색 외 텍스트로 표시하며 스레드를 닫으면 원래 답글 버튼으로 포커스가 돌아온다` | 컴포넌트 `apps/web/test/a11y/labels.test.tsx` | PR | — | `QA-FR-CLIENT-07`: 200% 확대에서 주요 조작 가능, 그레이스케일에서 상태 구분 |
| FR-OPS-01 | `FR-OPS-01 서버 기본 바인드 주소는 127.0.0.1이고 tailnet 접근만으로 로그인이 생략되지 않는다` | 통합 `apps/server/test/ops/bind.int.test.ts` | PR | — | `QA-FR-OPS-01`: tailnet 밖·LAN 기기 접속 불가, Serve HTTPS만 허용, Funnel 꺼짐, DB 포트 비노출 |
| FR-OPS-02 | `FR-OPS-02 격리 복원본과 원본의 메시지·수정/삭제 상태·DM 멤버십·읽음 커서·seq·change 커서가 일치한다` | 드릴 `tools/restore-drill.sh`(합성 데이터) | G1 | — | `QA-FR-OPS-02`: 승인 기록·대조 결과 |
| FR-OPS-03 | `FR-OPS-03 합성 본문·자격 증명·토큰 카나리아가 앱·HTTP·WS 로그에 0건이고 허용 계측 필드만 기록된다` | 통합 `apps/server/test/ops/log-redaction.int.test.ts` | PR | `pnpm check:log-leak`(R3.3: 카나리아에 봇 토큰·push endpoint 추가), 단위 `apps/server/test/ops/metrics-allowlist.unit.test.ts`(PRD §10 키만) | `QA-FR-OPS-03`: Tailscale Serve 쪽 로그 점검 |
| FR-OPS-04 | `FR-OPS-04 CLEANROOM 5절 패턴 검사가 0건이면 통과하고 위반과 실행 오류는 실패한다` | 스크립트 자체 테스트 `tools/test/check-cleanroom.test.ts` | PR | `pnpm check:cleanroom`, `pnpm check:design-tokens` | `QA-FR-OPS-04`: 디자인 출처 검토(디자인 §2·§15 대조) |
| FR-OPS-05 | `FR-OPS-05 허용목록 밖 형식과 상한+1바이트 첨부는 저장되지 않고 내용으로 형식을 판정하며 비참여자는 404이고 Range 요청은 206이며 보존 만료·메시지 삭제 시 바이트가 지워진다` | 통합 `apps/server/test/attachments/attachments.int.test.ts` | PR | 통합 `apps/server/test/attachments/attachment-headers.int.test.ts`(nosniff·sandbox CSP·no-store), `apps/server/test/attachments/attachment-order.int.test.ts`(첨부 순서 = 요청 순서, R3.7), 컴포넌트 `apps/web/test/conversation/attachments/audio-attachment.test.tsx` | `QA-FR-OPS-05`(iPhone PWA mp3 재생) |
| FR-BOT-01 | `FR-BOT-01 봇 계정은 로컬 명령으로만 생기고 이메일 로그인은 일반 실패와 같은 오류로 거부되며 세션 쿠키가 발급되지 않고 비활성화 후 5초 안에 봇 연결이 닫힌다` | 통합 `apps/server/test/bots/bot-account.int.test.ts` | PR | 통합 `apps/server/test/bots/bot-admin-cli.int.test.ts`: 원격 생성 라우트 0, create가 owner DM 동시 생성 | — |
| FR-BOT-02 | `FR-BOT-02 봇 토큰은 해시로만 저장되고 폐기·회전 후 옛 토큰은 401이며 봇 토큰으로 사람 API와 사람 쿠키로 봇 API를 호출하면 401이고 Origin·Cookie가 붙은 봇 요청은 거부된다` | 통합 `apps/server/test/bots/bot-token.int.test.ts` | PR | 통합 `apps/server/test/bots/bot-listener-bind.int.test.ts`: 봇 리스너 루프백 전용·`/api/bot/v1/**` 외 404 | `QA-FR-BOT-02`(Serve 설정에 봇 포트 없음 확인) |
| FR-BOT-03 | `FR-BOT-03 봇은 owner DM 밖 대화의 이력·이벤트·쓰기·DM 생성이 거부되고 모든 메시지 projection의 author_kind는 서버가 정한다` | 통합 `apps/server/test/bots/bot-scope.int.test.ts` | PR | `FR-CONV-04` 접근 매트릭스에 봇 행위자 포함(`apps/server/test/conversations/access-matrix.int.test.ts` 보조 케이스) | — |
| FR-BOT-04 | `FR-BOT-04 봇 토큰으로 만든 답글도 1단 스레드 규칙과 같은 대화 root만 허용하며 봇 답글은 root_reply_count와 스레드 unread 규칙을 따른다` | 통합 `apps/server/test/bots/bot-thread.int.test.ts` | PR | — | `QA-FR-BOT-04`(어댑터 pytest: 최상위=새 세션·답글=같은 세션 매핑 결과 첨부) |
| FR-BOT-05 | `FR-BOT-05 봇 연결 60초 단절 중 owner 메시지와 수정·삭제가 생겨도 봇 sync·WS 따라잡기에서 누락·중복이 0이고 rate limit 초과 전송·수정은 429로 저장되지 않는다` | E2E `e2e/bot-catchup.e2e.test.ts` | PR | 통합 `apps/server/test/bots/bot-rate-limit.int.test.ts` | — |
| FR-BOT-06 | `FR-BOT-06 슬래시로 시작하는 owner 메시지는 작성기가 가로채지 않고 원문 그대로 전송·표시되며 승인 요청 안의 명령 문구는 인라인 코드로 보인다` | 컴포넌트 `apps/web/test/conversation/slash-text.test.tsx` | PR | — | `QA-FR-BOT-06`(어댑터 pytest: owner 외 작성자 `/approve` 무시 + 실기 승인 왕복 1회) |

- **합계:** AUTH 5 · CONV 4 · MSG 9 · SYNC 7 · CLIENT 6 · OPS 5 · BOT 6 = **42**. PRD v1.3 FR 표에서 우선순위 `P0` 행을 grep으로 센 값과 같아야 합니다(R3.3, ADR-001 D-2: 기존 33 + 신규 BOT-01–06·MSG-10 + 승격 CLIENT-05·OPS-05).

**FR이 아닌 G1 선행 운영 검증:**

| ID | 지정 테스트 이름 | 계층·파일 | 실행 | 수동 |
|---|---|---|---|---|
| BOOT-01 | `BOOT-01 빈 합성 DB에서 owner 최초 생성은 성공하고 재실행은 기존 계정을 바꾸지 않고 실패하며 owner를 만드는 원격 라우트가 없고 이후 초대 발급과 member 수락이 된다` | 통합 `apps/server/test/auth/bootstrap.int.test.ts`(원격 경로 부재는 2-4 레지스트리로 단언) | PR | `QA-BOOT-01`: 합성 환경에서 `docs/runbooks/BOOTSTRAP_OWNER.md` 1회 실행 증거(PRD:142 순서). 실제 계정 생성은 이 문서가 승인하지 않음 |

### 6-3. TRD TR-SEC → 테스트 (보조 표, R1 약속 이행 · NC-01 게이트 편입)

TR-SEC 항목의 정본은 TRD §5 TR-SEC 표(TR-SEC-01–10)와 §5-1 R3.2 추가 행(TR-SEC-11·12), R3.3 추가 행(TR-SEC-13–15, ADR-001)입니다. 아래 표는 `check:fr-coverage` 입력입니다(5-1).

**표 형식 계약:** 5열(ID / 지정 테스트 이름 / 계층·파일 / 실행 / 수동) 순서를 유지하고, 행 ID는 `TR-SEC-01`…`TR-SEC-15`가 빠짐·중복 없이 한 번씩 나옵니다. FR 지정 테스트로 판정하는 행은 "지정 테스트 이름" 칸에 `→ FR-XXX-nn`(참조)만 두고, 그 FR(6-2)의 판정을 따릅니다. 자체 테스트가 필요한 행만 백틱으로 감싼 지정 이름을 두며, 6-2 행과 같은 규칙으로 판정합니다. 바꾸면 `check:fr-coverage` 파서를 같은 PR에서 고칩니다.

| ID | 지정 테스트 이름 | 계층·파일 | 실행 | 수동 |
|---|---|---|---|---|
| TR-SEC-01 | → FR-CONV-04, FR-AUTH-03 | 매 요청 세션·membership(접근 매트릭스) | — | — |
| TR-SEC-02 | `TR-SEC-02 비밀번호·세션·초대 표식 원문이 DB 모든 컬럼과 로그에 0건이다` | 통합 `apps/server/test/auth/secret-storage.int.test.ts`(로그 측면은 FR-OPS-03도 판정. R3.3: 표식에 봇 토큰 omsb_ 원문·VAPID 개인키 추가) | PR | — |
| TR-SEC-03 | → FR-AUTH-06 | CSRF header + Origin | — | — |
| TR-SEC-04 | → FR-AUTH-02, FR-AUTH-03 | revoke·비활성화 WS 전파 | — | — |
| TR-SEC-05 | → FR-MSG-01 | 안전한 입력 표시 | — | — |
| TR-SEC-06 | `TR-SEC-06 WS frame은 TRD 상한에서 처리되고 상한+1 바이트는 저장 없이 거절된다` | 통합 `apps/server/test/realtime/frame-limit.int.test.ts`(HTTP 본문 크기 경계는 FR-MSG-01 보조 `limits.int.test.ts`) | PR | — |
| TR-SEC-07 | → FR-OPS-01 | tailnet 전용 노출 | — | — |
| TR-SEC-08 | → FR-CLIENT-04 | 본문 지속 캐시 금지(+ 5-1 `check:no-persist-cache`) | — | — |
| TR-SEC-09 | → FR-OPS-03 | 개인정보 없는 계측(FR-OPS-03 보조 `metrics-allowlist.unit.test.ts`) | — | — |
| TR-SEC-10 | → FR-OPS-02 | 백업/복원 경계 | — | — |
| TR-SEC-11 | `TR-SEC-11 세션 쿠키는 HttpOnly·Secure·SameSite=Lax·Path=/이고 Domain 속성이 없으며 운영 설정에서 Secure를 끌 수 없다` | 통합 `apps/server/test/auth/cookie-attrs.int.test.ts`(Set-Cookie 단언, THREAT_MODEL NC-08) | PR | — |
| TR-SEC-12 | → FR-AUTH-06 | 로그인 제한(TRD §5-1 S1) | — | — |
| TR-SEC-13 | → FR-BOT-02 | 봇 토큰 경계(TRD §5-2) | — | — |
| TR-SEC-14 | → FR-OPS-05 | 첨부 형식 판정·응답 헤더(TRD §6-1). 문서·텍스트 계열은 FR-OPS-09(6-6, TRD §6-1-1 — 다운로드 헤더 보조 `document-headers.int.test.ts`) | — | — |
| TR-SEC-15 | → FR-CLIENT-05 | push payload 무본문·endpoint 허용목록(TRD §6-2) | — | — |

### 6-4. FR-MSG-08 이벤트 순서 사례 (지정 테스트가 모두 포함)

입력 처리 우선순위와 각 사례의 기대 동작은 **정본: 디자인 레퍼런스 §7-4**입니다. 테스트는 아래 순서를 jsdom 이벤트로 재현하고, 기대값은 정본 규칙에서 가져옵니다.

1. `keydown Enter` + `isComposing=true` → 전송 0.
2. `keydown Enter` + `keyCode=229` → 전송 0.
3. **`compositionend` 직후 같은 틱의 `keydown Enter`(`isComposing=false`)** → 전송 0, 그 다음 독립 Enter → 전송 1(Fable D-2: Safari 실패 경로).
4. 조합 확정 후 시간이 지난 독립 Enter는 버리지 않음 → 전송 1.
5. 조합 중 `Shift+Enter`, 마우스로 조합 확정 후 Enter, 연속 입력, 전송 응답 대기 중 새 조합 시작 → 정본 우선순위대로(입력 훼손 0, 대기 중 초안 보존).
6. 멘션 후보가 열린 상태의 Enter → 정본 우선순위대로(후보 선택과 전송이 동시에 일어나지 않음).

### 6-5. FR-SYNC-01 측정 방법 (SOL-V3)

PRD:89는 "DB 저장 → 다른 기기 **표시**"를 요구합니다. 수신 시각만으로는 통과를 주장하지 않습니다.

- **(a) 프로토콜 지연:** `perf/latency.perf.ts`가 20연결·5msg/s·10분 부하를 만들고, 같은 맥에서 돌므로 서버와 같은 시계로 커밋(`created_at`) → Node 클라이언트 수신 지연 p50/p95를 기록합니다.
- **(b) 표시 지연(같은 시계):** 부하 중 같은 맥의 실제 브라우저 1개(ego-browser)를 관측 기기로 붙입니다. 웹 클라이언트는 측정 빌드에서만 `message.created` 수신 후 해당 항목이 DOM에 그려진 시점(`requestAnimationFrame` 이후)과 메시지 `created_at`의 차이를 **메모리 히스토그램**에만 누적합니다. 서버와 브라우저가 같은 맥이라 시계가 같습니다. 판정은 이 (b) p95 ≤ 1000ms입니다.
- **개인정보:** 상관에 쓰는 메시지 ID는 메모리에서만 쓰고 디스크·로그·계측에 남기지 않습니다. 결과로는 구간값·p50/p95·표본 수만 남깁니다(PRD §10, PRD:171).
- **휴대폰:** 시계가 달라 (b)를 같은 방식으로 재지 않습니다. iPhone은 (a)와 QA 체감 기록만 남기고, (a) p95 + 맥 (b)의 렌더 구간 p95를 더한 값은 **추정치**로만 표기합니다(두 p95의 합은 전체 p95의 보장값이 아님).

### 6-6. P1 선택 FR 매핑 (단계 P2 v1, G2 입력)

단계 P2 v1에서 고른 P1 FR의 지정 테스트 표입니다(BOT_CHANNEL_SPEC §7-3·§10-1 Q7 ★, 2026-11-10 영환님 결정). 6-2는 PRD P0 집합과 양방향으로 같아야 하므로(`tools/check-fr-coverage.ts`) P1 FR 행은 6-2에 넣지 않고 이 절에 둡니다. 기존 6-4·6-5 절 번호는 다른 문서가 참조하므로 바꾸지 않고 이 절을 6-6으로 둡니다.

**표 형식 계약:** 6-2와 같은 6열(FR / 지정 테스트 이름 / 계층·파일 / 실행 / 필수 보조 증거 / 수동) 머리와 같은 셀 규칙을 씁니다. 현재 `check:fr-coverage`는 이 절을 읽지 않습니다. 이 절을 "선택된 P1 FR" 집합으로 읽는 체커 확장과 자체 테스트는 구현 레인(L1)이 같은 PR에서 합니다. 이름을 다듬으면 이 표와 테스트 제목을 같은 PR에서 맞춥니다.

| FR | 지정 테스트 이름 | 계층·파일 | 실행 | 필수 보조 증거 | 수동 |
|---|---|---|---|---|---|
| FR-BOT-08 | `FR-BOT-08 owner만 참여 중인 공개 채널에 활성 봇을 추가·제거하고 일반 멤버·비참여자·DM·사람 대상 요청은 거부되며 제거 후 봇 이력·쓰기는 404이고 기존 구독은 끊긴다` | 통합 `apps/server/test/bots/bot-channel-membership.int.test.ts` | PR | 통합 `apps/server/test/conversations/access-matrix.int.test.ts`: 새 라우트 2개 × {owner, 일반 멤버, 비참여자, 봇 토큰} | — |
| FR-BOT-09 | `FR-BOT-09 채널에 추가된 봇은 참여 이후 메시지만 이력·답글·snapshot·sync·WS replay·WS 실시간·첨부로 받고 참여 전 루트에 달린 새 답글과 루트 재전송도 받지 않으며 추가·제거 때 봇 연결에 멤버십 변화 프레임이 한 번 온다` | 통합 `apps/server/test/bots/bot-channel-scope.int.test.ts` | PR | 단위 `apps/server/test/bots/bots.unit.test.ts`: `/me` 대화 종류 projection | — |
| FR-BOT-10 | `FR-BOT-10 채널에서 owner가 봇을 멘션하면 봇이 받는 message.created의 mention_user_ids에 봇 ID가 있고 멘션 없는 글과 비참여 봇에는 없다` | 통합 `apps/server/test/bots/bot-channel-mention.int.test.ts` | PR | — | `QA-FR-BOT-10`(어댑터 pytest `integrations/hermes-plugin/tests/test_channel.py` BOT_CHANNEL_SPEC §5-9 케이스 1–8 결과 첨부 + 실기 채널 멘션 왕복 1회) |
| FR-BOT-11 | `FR-BOT-11 채널 헤더 봇 컨트롤은 owner에게만 보이고 봇을 추가하면 멘션 후보에 봇 배지와 함께 나타난다` | 컴포넌트 `apps/web/test/conv-bots/bot-channel-control.test.tsx` | PR | — | — |
| FR-OPS-09 | `FR-OPS-09 허용 문서 9종은 내용으로 판정해 저장하고 허용목록 밖·다중 형식 일치·암호화·확장자 불일치는 415로 저장되지 않는다` | 통합 `apps/server/test/attachments/documents.int.test.ts` | PR | 단위 `apps/server/test/attachments/doc-sniff.unit.test.ts`, `apps/server/test/attachments/doc-sniff-limits.unit.test.ts`, `apps/server/test/attachments/doc-macro.unit.test.ts`, `apps/server/test/attachments/filename-normalize.unit.test.ts`, 통합 `apps/server/test/attachments/document-limits.int.test.ts`, `apps/server/test/attachments/document-headers.int.test.ts`, 컴포넌트 `apps/web/test/conversation/attachments/document-attachment.test.tsx`(텍스트 계열 3종·415 하위 코드 포함) | `QA-FR-OPS-09` |
| FR-AUTH-04 | `FR-AUTH-04 본인 세션 목록은 거친 기기 라벨만 싣고 원격 로그아웃은 본인 세션만 폐기해 5초 안에 그 세션의 WS를 닫고 push 구독을 지우며 남의 세션과 없는 세션은 같은 404다` | 통합 `apps/server/test/auth/sessions-remote-logout.int.test.ts` | PR | 통합 `apps/server/test/conversations/access-matrix.int.test.ts`: `DELETE /api/sessions/{id}` × {본인, 다른 계정, 미인증}, 컴포넌트 `apps/web/test/sessions/session-list.test.tsx` | — |

- FR-BOT-03 지정 테스트(6-2)는 바꾸지 않습니다.

## 7. 위험

| ID | 위험 | 영향 | 대응 | 상태 |
|---|---|---|---|---|
| R-01 | 테스트가 운영 DB `ohmyslack`에 붙음 | 실데이터 파괴 | DB 이름 `_test`·로컬 호스트 강제 + 전용 role의 `ohmyslack` CONNECT 없음 + 실행별 스키마(5-1) | 설계 |
| R-02 | 브라우저 자동 E2E 부재 | UI 회귀가 PR에서 안 잡힘 | 컴포넌트 테스트 + 프로토콜 E2E + 단계 게이트 수동 QA. 범위는 ⚖️-2 | ⚖️ |
| R-03 | iOS PWA 백그라운드에서 WS 끊김 | 복귀 직후 오래된 화면 | `visibilitychange` 복귀 때 항상 catch-up, 완료 전 최신 표시 금지(FR-SYNC-07, TRD:126) | 설계 |
| R-04 | 맥 잠자기·종료 | 모든 기기 접속 불가 | UI 연결 끊김 표시. 상시 구동 방식은 ⚖️-5 | ⚖️ |
| R-05 | 로컬 개발(http://localhost)과 운영(Serve HTTPS)의 쿠키 `Secure`·Origin 차이 | 개발에서는 통과, 운영에서 로그인 실패 | 쿠키·Origin 설정을 환경별로 분리(값 정본: TRD:132–133). G1 QA는 Serve HTTPS 경로에서 수행. 브라우저별 localhost `Secure` 쿠키 처리는 확인 필요 | 확인 필요 |
| R-06 | 문서 간 ID·이름 드리프트 | 테스트 매핑 누락 | `check:fr-coverage`가 PRD↔6-2 집합 불일치를 차단. API·이벤트 이름은 `shared` 스키마 한 곳(B5) | 설계 |
| R-07 | 클린룸 누출(참고 이미지·색·소리) | 상표·트레이드 드레스 위험 | `check:cleanroom` + `check:design-tokens` + W-04b 독자 제작 표기 + QA-FR-OPS-04 | 설계 |
| R-08 | `conversations.last_seq`·`sync_clock` 단일 행 잠금 경합 | 처리량 저하 | 개인 규모에서는 영향이 작다고 추정(미측정). `sync_clock`은 모든 변경 트랜잭션을 직렬화하므로(TRD:66) FR-SYNC-01 측정에서 확인 | 추정 |
| R-09 | 단일 프로세스 메모리 팬아웃은 재시작 시 이벤트 유실 | 일시적 미표시 | 재접속 catch-up이 메움(B4). 다중 프로세스는 범위 밖 | 설계 |
| R-10 | Node·PostgreSQL 버전 확정 | 엔진 고정 오류 | TRD:35 절차(Node 26 LTS 여부 확인 후 고정)와 PG 운영 버전 확인을 W-01 완료 조건에 넣음 | R3 정합 |
| R-11 | 디자인 레퍼런스 R3가 병렬 작성 중 | 구간·컴포넌트명이 이 문서 작성 후 바뀜 | 값을 복제하지 않고 § 인용 + 토큰 모듈 상수로 테스트(10절 A5). 테스트 파일명만 따라 바뀜 | 설계 |
| R-12 | Hermes 게이트웨이·플러그인 API 변경 | 어댑터 파손, Jarvis 대화·브리핑 중단 | 어댑터 계약 테스트를 가짜 ohmyslack 서버로 고정(W-20), Hermes 업데이트 후 `QA-FR-BOT-04` 재실행 | 설계 |

## 8. 하지 말 것 (개발 단계)

1. 운영 DB에 테스트·마이그레이션 실험을 하지 않습니다. `.env` 값을 읽거나 로그·문서에 남기지 않습니다.
2. shared-infra의 compose·`backup.sh`·ACL을 수정하지 않습니다. 테스트 DB·임시 복원 DB 생성은 승인 후 운영 절차로 합니다.
3. Redis·메시지 브로커·마이크로서비스를 넣지 않습니다(확정 결정 0-6).
4. 대화 본문을 기기 저장소에 지속 캐시하지 않습니다(FR-CLIENT-04). 기기에 남기는 것은 숫자 checkpoint뿐입니다.
5. Slack 코드·에셋·스크린샷·색·소리·폰트를 쓰지 않습니다. CLEANROOM 금지 문자열 목록을 다른 파일에 복제하지 않습니다.
6. Playwright·Puppeteer를 설치하지 않습니다(영환님 직접 지시, 6-1). 브라우저 확인은 ego-browser로만 합니다.
7. Tailscale Funnel을 켜지 않습니다. 서버를 `0.0.0.0`에 바인드하지 않습니다.
8. 수동 체크를 실행하지 않고 "PASS"로 표시하지 않습니다. 미검증은 미검증으로 보고합니다.
9. 정본 수치·구간·문구를 이 문서나 테스트 이름에 새로 정하지 않습니다. 상수 모듈을 거칩니다.

## 9. 결정 필요(⚖️) — 위험 순

| ID | 결정 | 권고 | 시점 |
|---|---|---|---|
| ⚖️-1 | 통합 테스트 DB 위치 | (A) shared-infra에 `ohmyslack_test` + 전용 role 생성 — 운영자(영환님) 승인 필요, CI와 같은 버전 / (B) 로컬 전용 별도 PostgreSQL 인스턴스(컨테이너) — shared-infra 무변경, 대신 운영 major와 맞추는 관리 필요. **A 권고**(운영과 같은 서버·버전에서 검증). 통합 테스트를 포기하는 안은 권하지 않습니다 | G0 |
| ⚖️-2 | 브라우저 자동 E2E 수준 | 직접 지시(6-1)를 유지하고 수동 QA(ego-browser·실기기)로 메우는 안 권고. 예외는 영환님만 정할 수 있습니다 | G0 |
| ⚖️-3 | CI 실행 위치 | GitHub Actions + 운영과 같은 PG major 서비스 권고. 비공개 저장소 사용량 조건은 확인 필요. 쓰지 않으면 로컬 게이트 + QA 재실행 | G0 |
| ⚖️-4 | FR-OPS-02 격리 복원 대상 DB | 드릴할 때만 만들고 끝나면 지우는 임시 DB 권고. 생성·삭제는 승인된 운영 절차로. 보존·RPO/RTO는 PRD ⚖️-3 | W-13 전 |
| ⚖️-5 | 맥 상시 구동(launchd 등)과 Tailscale Serve 설정 적용 | 런북 작성(W-12) 후 영환님이 적용. 이 문서는 적용을 승인하지 않습니다 | 파일럿 전 |
| ⚖️-6 | 커버리지 80%의 적용 범위 | 전 패키지 라인 80% 권고(영환님 전역 규칙). 부하·수동·`bin/` 운영 명령은 제외 | G0 |
| ADR-001 | Hermes 연동 D-1–D-7(어댑터·G1 포함·Web Push·첨부 저장·승인·어댑터 위치·토큰 만료) | 2026-11-08 영환님 ★ 전부 채택 — `docs/decisions/ADR-001-hermes-agent-integration.md` §8 | 결정됨(R3.3) |

## 10. 문서 간 정합 (R3 결과)

| # | 항목 | R3 처리 | 정본 |
|---|---|---|---|
| A1 | P0 FR 목록 | PRD v1.2의 33개로 6-2 전 행 재대조. 테스트 이름을 v1.2 수용 기준에 맞춰 갱신. R3.3: PRD v1.3 P0 42개(ADR-001)로 6-2에 9행 추가 | PRD §7 |
| A2 | 테이블 | 이 문서는 이름을 정하지 않음. W-05가 TRD §2를 그대로 구현 | TRD §2 |
| A3 | API·WS·커서 | 전역 `change_id` 커서·watermark·snapshot/410·`read.updated.thread_root_id`·전송 응답 `change_id`로 2-3 갱신 | TRD §3–4 |
| A4 | 수치·상태 코드·Node 버전 | 테스트는 `shared` 상수로 TRD 값을 읽음. 상태 코드는 TRD:105 | TRD §2·§3·§5 |
| A5 | 구간·폭·컴포넌트명·문구·키맵·IME·아이콘 | 값 복제 없이 § 인용. 디자인 R3 확정값을 토큰 모듈로 옮기고 테스트는 그 상수를 읽음. 작성 시점 디자인은 R1이라 최종값 대조는 Jarvis 통합 확인(PRD ⚖️-5) | 디자인 §3·§5–9·§11 |
| A6 | 계측 이벤트·허용 필드 | B6 로거·`metrics-allowlist.unit.test.ts`가 PRD §10 표를 구현 | PRD §10 |
| A7 | CLEANROOM 5절 원문 한 줄은 grep 실행 오류를 통과로 이어 갈 수 있음 | 원본은 수정하지 않고 `check:cleanroom`이 종료 코드를 분기(5-1). 원문 개정 여부는 CLEANROOM 소유자 판단 | CLEANROOM.md(이 문서 범위 밖) |
| A8 | 초기 owner 운영 증거 | `BOOT-01`(6-2 하단)·W-05b·G1 ②로 추적 | 이 문서(PRD:140, :197) |

**남은 ⚖️ 미정합 — 없음(문서 간 계약 충돌 기준).** 단, 디자인 레퍼런스 R3 최종값과의 대조는 이 문서 작성 시점에 불가능했으므로 Jarvis 통합 확인 대상으로 남깁니다(A5). 9절 ⚖️-1–6은 영환님 운영 결정이며 문서 충돌이 아닙니다.

## 사실 / 추정 / 확인 필요

- **사실:** PRD v1.2의 우선순위 P0 FR은 33개였고(PRD 표 grep, PRD:188), R3.3에서 PRD v1.3 P0 42개(ADR-001 D-2)에 맞춰 6-2 표를 42행으로 늘렸습니다. TRD R3는 전역 `change_id` 커서·snapshot/410·`read.updated.thread_root_id`·상태 코드 표·TR-SEC-01–10을 정했습니다(TRD:53–54, :94–105, :118, :141–152). 브라우저 자동화 금지는 `~/.claude/rules/verification.md`의 사용자 지시입니다. 작성 시점 디자인 레퍼런스 파일은 R1(v0.1)이었습니다.
- **추정:** 모듈 6개 분할, slice 순서, 크기 S/M/L, 단일 행 잠금 경합 영향, iPhone 지연 합산치는 설계 판단입니다. 측정이나 구현 결과가 아닙니다.
- **확인 필요:** GitHub Actions 사용 조건, Electron fuse 이름의 착수 시점 표기, 브라우저별 localhost `Secure` 쿠키 처리, Node 26 LTS 여부·PostgreSQL 운영 버전(TRD:35), 디자인 R3 최종 구간·컴포넌트명.

## 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| R1 | 2026-11-07 | 최초 작성. PRD v1.1(P0 FR 33개)에 매핑. TRD·디자인 레퍼런스는 미도착이라 가정으로 표시 |
| R3 최종안 | 2026-11-07 | R2 Must-fix 13건 반영(거절 0). PRD v1.2·TRD R3 기준으로 6-2 전 행 재작성, 전역 커서 흐름, 접근 메타 레지스트리, `check:cleanroom` 종료 코드 분기, `check:fr-coverage` 진행/판정 모드, `check:no-persist-cache` 정의, 필수 보조 증거 열, 독자 에셋 W-04b, BOOT-01, TR-SEC 보조 표, FR-SYNC-01 같은 시계 표시 측정 추가 |
| R3.2 (NC-01) | 2026-11-07 | THREAT_MODEL NC-01·TRD R3.2 반영: 6-3을 `TR-SEC-01`–`12` 5열 표로 바꾸고(자체 지정 02·06·11, 나머지 `→ FR` 참조), 5-1 `check:fr-coverage` 입력에 6-3 추가 |
| R3.3 (ADR-001) | 2026-11-08 | ADR-001 D-1–D-7 ★ 채택 반영: 모듈 bots·attachments·push, 경계 규칙 B9·B10, access 메타 `attachment`·`bot`, G1 P0 42개·Hermes 증거, 6-2 9행(FR-BOT-01–06·FR-MSG-10·FR-OPS-05·FR-CLIENT-05)·6-3 3행(TR-SEC-13–15, `check:fr-coverage` ID 집합 15), WBS W-18–W-24, R-12 |
| R3.4 (BOT_CHANNEL_SPEC) | 2026-11-10 | 봇 채널 참여 P1 FR(영환님 결정, BOT_CHANNEL_SPEC §10-1 Q1–Q8 ★ 채택): 2-4 `conversation` 메타 예시에 봇 추가·제거 라우트, 단계 P2 v1 후보에 FR-BOT-08–11, 새 절 6-6 P1 선택 FR 매핑(4행). 6-2·6-3·P0 42개 불변 |
| R3.5 (ADR-002 정합) | 2026-11-13 | ADR-002 1단계 정본 정합(p2s1-canon-align): 6-6에 FR-OPS-09·FR-AUTH-04 행, WBS W-25–W-30(1a 구현 완료·미배포, 1b S1·A1·W1, 1c 서버·웹), B10 문서 판정기 한 줄, 6-3 TR-SEC-14에 FR-OPS-09 참조. 6-2·P0 42개 불변 |
| R3.6 (p2s1-attach-order) | 2026-11-14 | TRD R3.7 첨부 표시 순서: WBS W-31(마이그레이션 `0007`), 6-2 FR-OPS-05 보조 증거에 `attachment-order.int.test.ts`. 6-2 지정 테스트·P0 42개 불변 |

### R3.1 Jarvis 정합 (2026-11-07)
- §5-1 `pnpm -r test -- --coverage` → `pnpm -r test --coverage` (pnpm 10.30.2는 `--`를 vitest에 넘겨 커버리지가 꺼짐, G0 레인 실측).
- §2-1·W-04b 폰트: 서브셋 서술을 디자인 §3-1(공식 빌드 무수정)에 맞춤.
- ⚖️-1 결정: (A) 채택 — shared-infra `ohmyslack_test` DB + 전용 role `ohmyslack_test`(운영 `ohmyslack` CONNECT 없음) 생성 완료. 접속 정보는 저장소 루트 `.env.test`(600, git ignore).
- ⚖️-2(자동 E2E 없음)·⚖️-3(GitHub Actions)·⚖️-6(전 패키지 라인 80%): 권고안 채택.

### R3.2 Jarvis 정합 (2026-11-07)
- BOOT-01 지정 테스트 파일 경로를 구현 위치 `apps/server/test/auth/bootstrap.int.test.ts`로 정정(W-05b). 지정 이름 중 "이후 초대 발급과 member 수락" 단언은 W-06b가 같은 `it`에 추가.

## 리뷰 반영 기록

처리 합계: **Must-fix 13건 — 반영 13, 거절 0, 부분 0.** Should-fix는 아래 표에 함께 적었습니다. 줄 번호는 이 파일(R3) 기준입니다.

| 리뷰어 | 항목 ID | 처리(반영/거절/부분) | 변경 위치 file:line 또는 거절 근거 |
|---|---|---|---|
| GPT-Sol | SOL-V1 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:181` — grep 종료 코드 0/1/2+ 분기, 정본 블록 읽기, 자체 테스트 fixture; `:140` W-02 완료 조건; `:284` FR-OPS-04 지정 테스트; `:380` A7(원본 미수정) |
| GPT-Sol | SOL-V2 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:82` B2 — 전 라우트·WS 동작 `access` 메타 필수; `:98` 2-4 메타 정의·대상 라우트(`/api/messages/{id}`·replies·`/api/sync`·`read-state`·subscribe 포함)·비참여/나감/비활성 매트릭스; `:260` FR-CONV-04 |
| GPT-Sol | SOL-V3 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:246` 지정 테스트 + 필수 보조 증거 열; `:262` MSG-02 커밋/롤백·서버 재기동 통합 테스트; `:269`·`:322` SYNC-01 같은 시계 표시 지연 측정; `:272` SYNC-04 배지 컴포넌트·실기기 |
| GPT-Sol | SOL-V4 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:119` G0 도구 smoke 게이트 / `:120` G1 완전 FR 게이트 분리; `:195` 진행·판정 모드, 지정 테스트 유일성·skip/todo/only·실행 결과·수동 증거 필드 대조; `:222` 수동 증거 형식 |
| GPT-Luna | Must-fix 1 (테스트 경로) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:75` 경로 정본·탐색 범위; `:252`–`:284` 6-2 전 행 `apps/server/test/…`·`apps/web/test/…` 전체 경로 |
| GPT-Luna | Must-fix 2 (MSG-02 영속성) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:262` 보조 `durability.int.test.ts`(커밋 후 응답·롤백·재기동 후 조회) — SOL-V3과 같은 변경 |
| GPT-Luna | Must-fix 3 (CLIENT-07) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:280` 지정 테스트에 스레드 닫기 후 답글 버튼 포커스 복귀, 수동 200% 확대 |
| GPT-Luna | Must-fix 4 (커서 범위) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:90` 2-3 — TRD 계정 전역 `change_id` 커서·기기별 checkpoint 1개·watermark·410 snapshot·구독 replay; `:270` SYNC-02 두 대화 이상·410 경로 |
| Claude-Fable | D-1 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:276` CLIENT-01 wide·medium 구간; `:277` CLIENT-02 모든 구간·경계 전후, QA 폭은 디자인 §11 목록 인용(값 복제 없음 — 디자인 R3 병렬) |
| Claude-Fable | D-2 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:311` 6-4 사례 3(`compositionend` 직후 같은 틱 Enter, `isComposing=false`); `:268` FR-MSG-08 |
| Claude-Fable | D-3 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:187` `check:no-persist-cache` 정의(lint·SW/checkpoint 단위 테스트·빌드 산출물 검사); `:87` B7 예외 2파일 — 숫자 checkpoint는 TRD:103 근거 |
| Claude-Fable | D-4 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:143` W-04b 독자 제작 아이콘·심볼·favicon·폰트 서브셋(목록 정본: 디자인 §9·§3-2); 2-1 트리 `public/icons`·`public/fonts` |
| Claude-Fable | D-5 | 반영 | SOL-V2와 같은 변경 — `docs/04-dev-design/DEV_DESIGN.md:82`, `:98`: 경로 변수명 대신 전체 라우트 수집, `message` 메타는 `messages.service`가 대화 해석 후 `assertAccess` |
| GPT-Sol | Should-fix 1 (테스트 DB) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:202` 로컬 호스트·전용 role·실행별 스키마; `:363` ⚖️-1 별도 로컬 인스턴스 대안 비교 |
| GPT-Sol | Should-fix 2 (브라우저 도구 서술) | 부분 | `docs/04-dev-design/DEV_DESIGN.md:239` 금지는 설계상 확대가 아니라 직접 지시(`~/.claude/rules/verification.md` 2026-09-15: 저장소·스크래치패드 설치 금지)임을 근거와 함께 명시. 서술 축소는 하지 않음 |
| GPT-Sol | Should-fix 3 (구간·TR-SEC 표) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:276`–`:277` 구간; `:294` 6-3 TR-SEC 보조 표 |
| GPT-Luna | Should-fix 1 (1:1 의미) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:246` |
| GPT-Luna | Should-fix 2 (API·이벤트 예시) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:90` 전송 응답 `change_id`, `read.updated.thread_root_id` |
| GPT-Luna | Should-fix 3 (PG 버전 조건부) | 반영 | `docs/04-dev-design/DEV_DESIGN.md:207` 5-2 운영 major 확인 후 고정; `:139` W-01 |
| Claude-Fable | D-6 / D-8 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:90` 2-3 전역 커서·전송 응답 TRD 값 |
| Claude-Fable | D-7 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:193` `check:design-tokens`; `:140` W-02 |
| Claude-Fable | D-9 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:255` AUTH-05 403; `:260` CONV-04 보조 404/401/403; `:265` MSG-05 403/404 (정본 TRD:105) |
| Claude-Fable | D-10 | 반영(상대 문서) | PRD:194에서 GPT-Sol이 FR 표 5열 계약 반영. 이 문서는 `docs/04-dev-design/DEV_DESIGN.md:248` 6-2 표 형식 계약을 짝으로 추가 |
| (정합) | PRD ⚖️-5 초기 owner 운영 증거 | 반영 | `docs/04-dev-design/DEV_DESIGN.md:292` BOOT-01; `:145` W-05b; `:120` G1 ② |
