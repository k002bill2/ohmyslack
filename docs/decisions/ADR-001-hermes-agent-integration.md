# ADR-001 — Hermes Agent(Jarvis) 연동: 플랫폼 플러그인 어댑터 + 봇 계정

- 상태: **채택(Accepted) — 2026-11-08 영환님, D-1~D-7 ★ 전부.** 정본 반영: PRD v1.3·TRD R3.3·DEV_DESIGN R3.3·UI_STATES·THREAT_MODEL·DESIGN_REFERENCE §6-2(레인 `p1-l0-canon-adr`). (채택 전 상태: 제안(Proposed) — 채택 전에는 정본을 바꾸지 않는다는 조건이었음.)
- 날짜: 2026-11-08
- 결정권자: 영환님 / 작성: Jarvis 레인 `p1-hermes-adr`
- 촉발 결정(영환님, 2026-11-08 취지): 「제일 중요한 부분은 Hermes와 연동이 가능한가. 지금 Slack을 쓰는 이유는 Hermes의 Jarvis와 대화를 주고받고 브리핑을 받기 위함」 → **Hermes 연동을 P0로 승격**.
- 표기: ★ = 이 ADR의 권장안. 근거 수준 — **사실**(파일:행으로 확인), **추정**(설계 판단), **확인 필요**(실기·추가 조사 필요).
- 경로 약어: `H/` = `/Users/younghwankang/.hermes/hermes-agent/` (읽기 전용으로만 참조, 복사 없음).

## 1. 맥락

### 1-1. 지금 Slack에서 Jarvis를 쓰는 방식 (사실, 브리프)

최상위 메시지 1개 = 스레드 1개 = Hermes 세션 1개이고 진행·결과가 그 스레드에 이어집니다. cron 브리핑은 채널에 텍스트 + mp3 음성(`MEDIA:`)으로 게시됩니다. 명령 승인(approve/deny), 이미지·파일 수신, 마크다운 표시가 쓰이며, 주로 iPhone에서 읽습니다.

### 1-2. ohmyslack 현재 상태 (사실)

| 영역 | 현재 | 근거 |
|---|---|---|
| 계정 | `users`에 사람/봇 구분 없음, `password_hash NOT NULL` | `apps/server/migrations/0001_initial_schema.sql:11-20` |
| 인증 | 쿠키 세션 `__Host-oms_session` 하나뿐 | `apps/server/src/modules/auth/guards.ts:8,26-36` |
| CSRF·Origin | 전역 훅이 모든 상태 변경 요청에 Origin 정확 일치를 요구(없음·`null` 거부) → Origin 없는 서버 간 POST는 403 | `apps/server/src/http/security.ts:29-62` |
| WS | `/api/ws`, Origin + 쿠키 세션 peek, 구독마다 `assertAccess`, 팬아웃 직전 재확인, `(after, watermark]` replay | `apps/server/src/modules/realtime/gateway.ts:69-74`, `realtime/hub.ts:172-187,266-320` |
| 배경 구독 | 웹은 현재 대화 외 모든 참여 대화를 checkpoint로 구독(FR-SYNC-04) | `apps/web/src/data/http-source.ts:463-475` |
| 렌더러 | 인라인 `text`/`link`, 블록 `paragraph`/`code`뿐 | `apps/web/src/features/conversation/render.ts:6-14` |
| 본문 상한 | 4,000 code point | `packages/shared/src/messages.ts:4,15-18` |
| 첨부·푸시 | 코드 0건. PWA는 커스텀 SW(앱 셸만 precache) | `apps/web/src/features/pwa/sw.ts:41-43` |
| 바인드 | `127.0.0.1`만 허용, trustProxy 없음 | `apps/server/src/bind.ts:4-16` |
| 정본 충돌 | PRD가 「앱 마켓·봇·워크플로」를 비목표로 둠, 파일 업로드·Web Push는 P1 | `docs/02-prd/PRD.md:146,117,105` |

### 1-3. Hermes 쪽 계약 (사실)

| 항목 | 내용 | 근거 |
|---|---|---|
| 플러그인 위치 | 번들 → `~/.hermes/plugins/<name>/` → 프로젝트 → entry-point 순서로 탐색, `plugin.yaml` + `register(ctx)` | `H/hermes_cli/plugins.py:3-7` |
| 활성화 | 사용자 플러그인은 config `plugins.enabled`에 있어야 로드 | `H/hermes_cli/plugins_discovery.py:322-326` |
| 등록 | `ctx.register_platform(name, adapter_factory, cron_deliver_env_var, standalone_sender_fn, max_message_length, platform_hint, AUTHZ…)` | `H/gateway/platform_registry.py:41-140` |
| 필수 메서드 | `connect`·`disconnect`·`send`·`get_chat_info` | `H/gateway/platforms/base.py:2627,2633,2637,4758` |
| 세션 키 | DM은 chat_id 단위 → 스레드=세션은 어댑터가 `thread_id`를 지정해서 만든다 | `H/gateway/session.py:691-734`; Slack 기본값 `dm_top_level_threads_as_sessions=true` `H/plugins/platforms/slack/adapter.py:2808-2811` |
| cron 전달 | `cron_deliver_env_var`(홈 채널), 명시 대상 `<platform>:<chat_id>[:thread]`, 게이트웨이 밖 전달은 `standalone_sender_fn` 필요 | `H/cron/scheduler_delivery.py:395-413,466-498,631-659`, `platform_registry.py:107-110` |
| MEDIA | `MEDIA:<path>` 추출, mp3는 (Telegram 외) 항상 `send_voice` | `base.py:3203-3241,194-204` |
| 승인 | 어댑터가 `_send_exec_approval_prompt`를 오버라이드하지 않으면 텍스트 프롬프트. 명령 `/approve`·`/approve session`·`/approve always`·`/deny`. 맨 「yes」는 승인 아님 | `base.py:2779-2783`, `H/locales/en.yaml:632-635`, `H/gateway/run_inbound.py:1309-1310` |
| 발신자 인가 | `*_ALLOWED_USERS` env + `allowlist_suppresses_pairing`; 검사 `_is_user_authorized_for_source` | `H/plugins/platforms/mattermost/gateway_env.py:18-23`, `H/gateway/run_inbound.py:226`, `H/gateway/authz_mixin.py:732-800` |
| 길이 | `MAX_MESSAGE_LENGTH` 기본 4096, `truncate_message`가 코드펜스 보존 분할 | `base.py:1933-1937,4773-4833` |
| 스트리밍 | `send`+`edit_message`. 이 맥 설정은 `streaming.enabled: false` | `base.py:1962-1968`, `~/.hermes/config.yaml:454-455` |
| api_server | OpenAI 호환 `127.0.0.1:8642`, `supports_async_delivery=False` → cron 결과가 가지 않음 | `H/gateway/platforms/api_server.py:154-169,1036-1039`, `H/cron/scheduler_delivery.py:30-32` |

## 2. 결정 (요약)

**★ ohmyslack을 Hermes 게이트웨이의 플랫폼으로 붙인다.** ohmyslack은 봇 계정과 루프백 전용 봇 API를 제공하고, Hermes 쪽에는 플랫폼 플러그인 어댑터(`ohmyslack`)를 둔다. 어댑터 소스는 ohmyslack 저장소 `integrations/hermes-plugin/`에서 관리하고, 영환님이 `~/.hermes/plugins/ohmyslack/`에 배포한다. Slack은 전환 기준을 충족할 때까지 병행한다.

## 3. 세부 결정 (a)–(j)

### (a) 봇 계정 모델 — ★ `users.kind = 'bot'`

- **선택**: 같은 `users` 테이블에 `kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','bot'))`. 봇은 `password_hash NULL`(CHECK로 사람만 NOT NULL), `email_norm`은 `<slug>@bot.invalid`(RFC 2606 예약 TLD), workspace 역할은 항상 `member`.
- **이유(추정)**: `messages.author_id`, `conversation_members`, `message_mentions`, read-state가 모두 `users` FK입니다. 별도 테이블이면 작성자가 다형(사람|봇)이 되어 FK·접근 검사·projection을 전부 바꿔야 합니다. `kind` 컬럼은 기존 경계(`assertAccess`)를 그대로 재사용합니다.
- **생성·폐기**: owner가 로컬 명령 `apps/server/bin/bot-admin.ts`(create / disable / token issue·rotate·revoke / list)로만 합니다. 원격 HTTP 생성 경로는 만들지 않습니다(`bootstrap-owner`와 같은 로컬 신뢰 루트, THREAT_MODEL TB-6). create는 owner와의 DM 「Jarvis」를 같은 트랜잭션에서 만듭니다.
- **사람 로그인 불가**: 로그인 서비스가 `kind='bot'`을 일반 실패와 같은 오류로 거부하고 `sessions` 행을 만들지 않습니다.
- 대안: 별도 `bots` 테이블 — 작성자 다형성 비용 때문에 기각.

### (b) 봇 인증 — ★ 범위 제한 Bearer 토큰 + 별도 루프백 리스너

- **토큰**: CSPRNG 32바이트 base64url + 접두사 `omsb_`. DB `bot_tokens`에 SHA-256만 저장(엔트로피가 높아 느린 해시 불필요 — 세션 토큰과 같은 방식, `apps/server/src/modules/auth/service.ts:10-14`). 발급 시 1회 출력. 봇당 미폐기 토큰 최대 2개(회전 겹침). 폐기·봇 비활성화 시 열린 봇 WS를 5초 안에 close(기존 세션 sweep 재사용, `realtime/hub.ts:53,124-134`). 만료 시각은 두지 않고 `last_used_at` 기록(★ — 루프백 전용·로컬 회전 CLI 전제).
- **리스너 분리**: 두 번째 Fastify 인스턴스가 `127.0.0.1:<BOT_PORT>`에만 바인드(기존 bind 가드 재사용). Tailscale Serve 설정에 넣지 않으므로 tailnet 기기에서도 닿지 않습니다(Hermes 게이트웨이는 같은 맥). 이 인스턴스는 `/api/bot/v1/**`만 등록합니다.
- **CSRF 예외 범위**: 봇 리스너에서만 CSRF 헤더·Origin 일치 검사를 쓰지 않습니다. 근거: 쿠키를 인증에 쓰지 않으므로 브라우저가 자격 증명을 자동으로 붙이는 CSRF 전제가 없습니다. 대신 `Origin` 또는 `Cookie` 헤더가 있는 요청은 거부(브라우저발 차단)합니다. 메인 리스너의 전역 훅(`security.ts`)과 `accountGuard` CSRF는 **변경하지 않습니다**. 메인 리스너는 `Authorization` 헤더를 인증에 쓰지 않습니다.
- 왜 "같은 리스너 + 경로 예외"가 아닌가: Serve 뒤에서는 모든 요청 출처가 127.0.0.1이라(TRD §5-1 S1) 루프백 판정으로 tailnet발 요청을 구분할 수 없습니다. 포트 분리는 Serve 설정만으로 노출 여부가 정해져 검증이 단순합니다(추정).

### (c) 명령 권한 — ★ 서버 멤버십 상한 + 어댑터 allowlist 이중 통제

- **서버측 근거**: ① 봇은 owner와의 Jarvis DM에만 참여(채널 참여는 P1, owner가 웹에서 명시적으로 추가할 때만). 봇 토큰으로는 DM 생성·채널 참여·멤버 조회 라우트가 없습니다. DM은 2인 고정이므로(TRD:64) 제3자가 Jarvis DM에 쓸 수 없습니다. ② 모든 메시지 projection에 서버가 채운 `author_kind`와 `author_id`. ③ `GET /api/bot/v1/me`가 `owner_user_id`를 돌려줌.
- **어댑터·게이트웨이**: Hermes AUTHZ에 `OHMYSLACK_ALLOWED_USERS=<owner user_id>` + `allowlist_suppresses_pairing=True`(`gateway_env.py:18-23`). 어댑터 자체도 `author_id != owner_user_id`인 메시지는 `handle_message`로 넘기지 않습니다(이중). 자기(봇) 메시지는 무시.
- **다른 멤버 메시지**: Jarvis DM에는 들어올 수 없습니다. 봇이 채널에 참여하는 P1 단계에서도 owner 외 작성자 메시지는 세션 생성·지시 처리 0, 응답도 하지 않습니다(사람이 본 내용이 지시로 흘러가는 프롬프트 인젝션 차단). owner가 남의 글을 인용·전달한 경우의 간접 인젝션은 Hermes 승인 게이트가 마지막 방어선입니다(잔여 위험, THREAT_MODEL-diff TM-BOT-05).

### (d) 대화 모델 — ★ 전용 DM 「Jarvis」 + 최상위 = 새 세션

- owner가 Jarvis DM에 쓴 **최상위 메시지** → 어댑터가 `thread_id = 그 메시지 id`로 `build_source` → 새 Hermes 세션(Slack 기본 동작과 같은 모델, `slack/adapter.py:2808-2811`; Mattermost `mattermost/adapter.py:580-582`).
- **스레드 답글** → `thread_id = thread_root_id` → 같은 세션. 봇의 진행·결과는 `thread_root_id`를 붙여 같은 스레드 답글로 게시(1단 스레드 규칙 FR-MSG-06과 일치 — 원문이 답글이면 루트로 보정).
- **브리핑**: cron `deliver=ohmyslack`(홈 채널 = Jarvis DM id, `OHMYSLACK_HOME_CHANNEL`) → **최상위 메시지**. owner가 그 브리핑 스레드에 답하면 그 스레드가 새 세션이 됩니다(추정 — 브리핑 원 세션과 이어지는지는 Hermes cron 세션 정책에 따름, 확인 필요).
- **채널 멘션**: H1–H3 범위 밖(★). P1에서 owner가 채널에 봇을 추가하면 Mattermost처럼 멘션 게이팅(`mattermost/adapter.py:506-526`).

### (e) 이벤트 수신 — ★ 기존 WS 프로토콜 재사용, 봇 리스너에서 Bearer handshake

- 봇 WS `/api/bot/v1/ws`는 사람 WS와 **같은 이벤트 스키마**(`packages/shared/src/realtime.ts:17-49`)와 같은 hub를 씁니다. handshake만 `Authorization: Bearer`.
- **구독 범위**: 연결 직후 `GET /api/bot/v1/me`의 참여 대화 전부를 `conversation.subscribe{after_cursor=checkpoint}`로 구독 — 웹 배경 구독(FR-SYNC-04, `http-source.ts:463-475`)과 같은 규칙. 봇은 참여 대화가 1–몇 개라 비용이 작습니다. 구독 시 `assertAccess`·팬아웃 직전 재확인은 기존 그대로(`hub.ts:172-187`).
- **따라잡기 커서**: 어댑터가 마지막으로 처리한 전역 `change_id`를 숫자 하나로 파일에 저장(Buzz 방식 `H/plugins/platforms/buzz/buzz_cursors.py:1-30` 참고, 위치 `~/.hermes/ohmyslack/cursor.json`). 재연결 시 `GET /api/bot/v1/sync?after=` → 구독 replay. 410이면 `snapshot`으로 재초기화하고 그 사이 owner 메시지는 처리하지 않습니다(안내 1건).
- **오래된 메시지 처리 상한**: 단절이 길었을 때 밀린 지시가 한꺼번에 실행되지 않도록 `created_at`이 15분(★ 제안값)보다 오래된 미처리 owner 메시지는 실행하지 않고 「오프라인 동안 받은 N건은 처리하지 않았습니다」 1건을 게시합니다. 중복은 message id로 `MessageDeduplicator`(`H/gateway/platforms/helpers.py:20-28`).
- **재연결**: 지수 백오프 2→60초 + 지터(Mattermost `mattermost/adapter.py:448-482`). 401/403은 non-retryable fatal(토큰 폐기 신호).

### (f) 전송 — 서식·길이·편집

**서식 지원 차이 (사실: 현행 렌더러 `render.ts:6-14,20,56-138`, `MessageBody.tsx:31-36`)**

| 서식 | Jarvis가 쓰는가(브리프) | 현행 ohmyslack | ★ 제안(FR-MSG-10) |
|---|---|---|---|
| 줄바꿈 | 예 | 지원 | 유지 |
| 코드 블록 ``` | 예 | 지원(언어 태그 버림) | 유지 |
| 자동 링크 http/https | 예 | 지원 | 유지 |
| `[텍스트](url)` 링크 | 예 | 미지원(원문 노출) | **추가**(http/https만) |
| 굵게 `**x**` | 예 | 미지원 | **추가** |
| 인라인 코드 `` `x` `` | 예 | 미지원 | **추가** |
| 글머리·번호 목록 | 예 | 미지원 | **추가** |
| 제목 `#`–`###` | 예 | 미지원 | **추가**(본문 크기 단계만, h1 남발 방지) |
| 기울임·취소선·인용·표 | 가끔 | 미지원 | 범위 밖(원문 그대로). 어댑터 `format_message`가 표를 코드 블록으로 감싸 정렬 보존(추정) |

- 렌더 원칙은 그대로: HTML 미생성, React 텍스트 노드, 선형 파서(`render.ts:16-19`).
- 어댑터 `platform_hint`로 「지원 서식은 위 ★ 목록」을 에이전트에 알립니다(`ADDING_A_PLATFORM.md:257-271`).
- **길이**: 서버 상한 4,000 code point. 어댑터 `MAX_MESSAGE_LENGTH = 3900`(분할 표시 여유) + registry `max_message_length=3900`, `len_fn`은 code point 기준, 분할은 `truncate_message`(코드펜스 보존, `base.py:4773-4833`). 분할 조각은 같은 스레드에 순서대로 게시.
- **편집/스트리밍**: ★ **기본 끔**. `edit_message`는 구현(봇은 자기 메시지 작성자이므로 PATCH 가능, `messages/repo.ts:234`)하되 스트리밍은 Hermes 설정(`streaming.enabled: false`, 현재값)을 따릅니다. 이유: edit마다 `conversation_changes` 행 + WS 이벤트가 생겨 보존 한도(100,000행, TRD:139)를 소모합니다. 켤 경우 `edit_interval` ≥ 2초 + 봇 수정 rate limit 60건/분.
- **타이핑 표시**: 범위 밖(presence FR-OPS-07은 P1). `send_typing`은 no-op.

### (g) 첨부 — ★ FR-OPS-05 최소 범위 P0 승격

| 항목 | ★ 제안 | 대안·근거 |
|---|---|---|
| 형식 허용목록 | `audio/mpeg`(mp3), `image/png`, `image/jpeg`, `image/webp` | SVG·HTML·PDF 거부(일반 파일은 FR-OPS-09 P1). mp3는 Hermes에서 `send_voice`로 옴(`base.py:194-204`) |
| 판정 | 서버 매직 바이트 판정, 선언 MIME·확장자 무시, 불일치 415 | — |
| 크기 | 파일당 10 MiB, 메시지당 4개 | 128kbps mp3 10 MiB ≈ 10분(추정) |
| 저장 위치 | PostgreSQL `attachment_blobs(bytea)` | 대안: 맥 로컬 디렉터리(0700). DB 저장은 단일 원장·백업/복원 드릴 일관성 장점, 공용 PG 용량 증가가 단점 → **결정 D-4** |
| 권한 | `access: attachment` → 첨부의 대화로 `assertAccess`, 비참여자 404 | 기존 단일 경계 재사용 |
| 응답 헤더 | `no-store`, `nosniff`, `CSP: sandbox; default-src 'none'`, `inline`(허용 미디어만), **Range 206 지원** | iOS 오디오 재생에 Range가 필요한지 **확인 필요**(실기 QA) |
| 보존 | 오디오 30일, 이미지 90일 후 바이트 삭제(자리표시자 유지), 메시지 삭제 시 즉시 | 용량 예: 3 MiB × 1일 1회 × 30일 ≈ 90 MiB(추정) |
| 업로드 흐름 | `POST attachments` → 미결속 id → 메시지 생성 `attachment_ids` → 1시간 미결속 자동 삭제 | Mattermost `POST /files` → `posts{file_ids}`와 같은 2단계(`mattermost/adapter.py:225-239`) |
| 수신(사람→Jarvis) | 웹 작성기에서 이미지 첨부 → 어댑터가 봇 토큰으로 받아 `cache_*_from_bytes` | H2 단계 |
| 본문 규칙 ★ | 첨부 메시지도 **본문 필수 유지**(FR-MSG-01·DB CHECK `0001_initial_schema.sql:125`·zod `messages.ts:15-18` 불변). 어댑터는 `send_voice` 등의 caption(없으면 파일명)을, 웹은 자리 문구를 본문으로 채움 | 대안: 첨부 있으면 빈 본문 허용 — 기존 P0 의미 변경(PRD:194 계약 1)이라 기각 |

### (h) 승인 UX — ★ 텍스트 명령(최소안)

- 어댑터는 `_send_exec_approval_prompt`를 **오버라이드하지 않습니다** → Hermes가 텍스트 프롬프트를 보내고(`base.py:2779-2783`) owner가 같은 스레드에 `/approve`, `/approve session`, `/approve always`, `/deny`로 답합니다(`en.yaml:632-635`). 맨 「yes」는 승인되지 않으므로(`run_inbound.py:1309-1310`) 대화 중 오승인 위험이 낮습니다.
- ohmyslack 쪽 추가 개발 0. 작성기가 `/`를 가로채지 않는지만 확인합니다(현재 slash 명령 기능 없음 — 확인 필요).
- 승인 권한: owner allowlist(§3-c) 밖 작성자의 `/approve`는 게이트웨이 인가 단계에서 버려집니다.
- 대안(P1 후보 FR-BOT-07): 버튼형 인터랙티브 메시지 — 메시지 종류·콜백 라우트·클릭 사용자 권한 확인(`slack/adapter.py:5517-5529`, `H/tools/approval.py:181`)이 필요해 서버·웹·어댑터 3곳 변경. iPhone에서 탭 한 번의 이득이 있으나 H1 범위에서 제외.

### (i) 알림 — ★ Web Push는 전환(H4)의 필수 요건, 도입은 H3

- **판단 근거(추정)**: 브리핑은 cron이 정해진 시각에 보내는 비동기 메시지입니다. 알림이 없으면 영환님이 앱을 열어야만 도착을 압니다. Slack을 계속 쓰는 이유 중 「브리핑을 받는다」의 실체는 iPhone 알림이므로, 푸시 없이 Slack을 끄면 기능 후퇴입니다. 반면 Slack과 병행하는 H1–H2 동안은 Slack 알림이 남아 있어 푸시가 없어도 됩니다.
- **범위(★ 최소)**: Jarvis DM의 새 최상위 메시지와 자기 스레드 답글, 자기 멘션. payload에는 `conversation_id`/`thread_root_id`/`from_bot`만, **본문·이름 미포함**, 알림 문구는 SW 고정(「Jarvis」/「새 메시지가 있습니다」). iOS는 silent push가 금지이므로 SW는 항상 알림을 띄웁니다(https://webkit.org/blog/12945/meet-web-push/).
- **조건(사실)**: iOS/iPadOS 16.4+, 홈 화면 추가 + manifest `display: standalone`, 권한 요청은 사용자 동작에서만(https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). 현 manifest는 standalone(`apps/web/public/manifest.webmanifest`).
- **네트워크**: 서버가 push service(`*.push.apple.com`)로 **outbound HTTPS**를 처음으로 합니다. 인바운드 노출은 변하지 않습니다. tailnet 전용 origin에서 iOS 구독·수신이 되는지는 공식 근거 없음 → **확인 필요**(QA-FR-CLIENT-05 실기 시험을 H3 첫 작업으로).
- **VAPID 키**: 로컬 명령 `vapid-keygen`으로 P-256 생성, 개인키는 저장소 밖 600 파일, 환경 변수로 경로만 주입, 미설정 시 푸시만 비활성. `sub`는 공백 없는 `mailto:` 실제 주소(Apple의 403 BadJwtToken 비공식 보고 — https://developer.apple.com/forums/thread/725473). 키 회전 = 전 구독 재등록(RFC 8292).
- 대안: ntfy·Pushover 같은 외부 푸시 앱 — 제3자 서비스에 알림 메타데이터가 쌓이고 앱이 하나 더 필요해 기각(추정).

### (j) 운영

- **어댑터 위치 ★**: 소스 `integrations/hermes-plugin/`(ohmyslack 저장소, pnpm 워크스페이스 밖, Python + pytest). 이유: 봇 API 계약과 같은 커밋에서 바뀌고, 계약 테스트를 함께 둘 수 있습니다. 배포는 영환님이 `~/.hermes/plugins/ohmyslack/`로 복사·심볼릭 링크 후 `hermes plugins enable <key>`(키가 manifest `name`인지 디렉터리명인지 **확인 필요**). 대안: Hermes 쪽 별도 저장소 — 계약 버전이 어긋날 위험.
- **구현 패턴**: 이 맥의 사용자 플랫폼 플러그인 `~/.hermes/plugins/homeassistant/`처럼 상대 import, `Platform("ohmyslack")` 동적 멤버, `env_enablement_fn` 사용(번들 플러그인의 절대 import·`Platform.X` 속성 접근은 사용자 플러그인에서 위험 — 조사 결과, 확인 필요). 비밀은 `get_scoped_secret`(`ADDING_A_PLATFORM.md:195-200`).
- **env 키(제안)**: `OHMYSLACK_URL=http://127.0.0.1:<BOT_PORT>`, `OHMYSLACK_TOKEN`, `OHMYSLACK_ALLOWED_USERS`, `OHMYSLACK_HOME_CHANNEL`. cron이 게이트웨이 밖에서 돌 때를 위해 `standalone_sender_fn`(REST 전송 + 첨부 업로드) 구현 필수(`platform_registry.py:107-110`).
- **게이트웨이 재시작**: 영환님이 수행합니다(에이전트는 `~/.hermes/**`를 쓰지 않음).
- **Slack 병행**: H1부터 Hermes에 Slack·ohmyslack 플랫폼을 함께 켭니다. 브리핑 cron은 두 곳에 전달(`deliver`에 두 대상 — 다중 대상 지원 여부 **확인 필요**, 안 되면 cron 작업 복제).
- **전환 기준(H4, 영환님 판정)**: 연속 7일 ① 브리핑 수신 유실 0 ② 음성 재생 성공 ③ iPhone 푸시 수신 ④ 스레드 세션 이어짐 실패 0 ⑤ 승인 왕복 1회 이상 성공 ⑥ 어댑터 fatal 0. 충족 시 Slack 플랫폼을 Hermes에서 끄되 설정은 30일 보존.
- **장애 폴백**: ohmyslack 프로세스 다운 → 어댑터 백오프 재연결, cron 전달 실패는 Hermes 로그 + (병행 중) Slack 전달로 대체. 전환 후에는 Slack 플랫폼 재활성화가 롤백 절차(런북 `docs/runbooks/HERMES_BOT.md` 신설 제안). 맥 전체 다운은 Hermes도 같은 맥이라 둘 다 멈춥니다(NFR-08과 같은 수용 위험).

## 4. 대안 비교

| 기준 | **A ★ 플랫폼 플러그인 어댑터** | B ohmyslack → Hermes api_server 직접 호출 | C Slack 유지·병행만 |
|---|---|---|---|
| 개요 | ohmyslack이 봇 API 제공, Hermes 어댑터가 메신저처럼 붙음 | ohmyslack 서버가 `/v1/chat/completions`·`/api/sessions`를 호출하고 응답을 봇 메시지로 게시 | ohmyslack은 사람 메신저로만, Jarvis는 Slack |
| 스레드=세션 | Hermes 세션 키 규칙 그대로(`session.py:691-734`) | ohmyslack이 `X-Hermes-Session-Id` 매핑 테이블을 직접 관리 | 현행 |
| cron 브리핑 | `cron_deliver_env_var`로 그대로 전달 | **불가** — api_server는 `supports_async_delivery=False`(`api_server.py:1036-1039`, `scheduler_delivery.py:30-32`). webhook deliver 우회는 확인 필요 | 현행 |
| 승인 | 텍스트 폴백 즉시 사용 | `/v1/runs/{id}/approval` 별도 UI 필요 | 현행 |
| MEDIA(mp3) | `send_voice`로 자연 전달 | 응답 텍스트에서 MEDIA 태그를 ohmyslack이 해석·파일 읽기(서버가 Hermes 파일시스템 접근 — 경계 악화) | 현행 |
| ohmyslack 결합 | 봇 API 계약만(Hermes 무관) | 서버가 Hermes 가용성·API 버전에 직접 의존 | 없음 |
| 보안 | 봇 토큰 1개, 루프백 | API_SERVER_KEY를 ohmyslack이 보관 + 에이전트 응답 실행 경로가 서버 안 | 데이터가 Slack에 남음 |
| 비용(추정) | 서버 4–6h + 어댑터 4–8h | 서버 8h+ + 브리핑 별도 경로 | 0 |
| 목표 충족 | 충족 | 브리핑 미충족 | **미충족**(영환님 결정과 배치) |

## 5. 결과·위험

- **좋아지는 것**: Jarvis 대화·브리핑이 본인 소유 서버에 남습니다. Hermes 쪽 기능(세션·cron·승인·MEDIA)을 재구현하지 않습니다.
- **정본 변경**: PRD v1.3(BOT 영역, FR-MSG-10, FR-OPS-05·FR-CLIENT-05 P0 승격, §8 봇 예외), TRD R3.3, DEV_DESIGN 6-2 매핑, UI_STATES 봇·첨부·푸시 상태, THREAT_MODEL 행 추가 — 제안 파일 `dev/active/p1-hermes-adr/*-diff.md`.
- **MVP 게이트 영향**: 새 P0가 `check:fr-coverage` 게이트 대상에 자동 편입(`tools/check-fr-coverage.ts:67-79`) → G1 범위가 커집니다. 분리 게이트 여부는 **결정 D-2**.

| 위험 | 등급(추정) | 완화 |
|---|---|---|
| 봇 토큰 탈취 → Jarvis 사칭 | M | 루프백 전용, 해시 저장, `omsb_` 접두 로그 마스킹, 회전·폐기 CLI |
| 다른 멤버 글이 지시로 유입(프롬프트 인젝션) | M | 멤버십 상한 + allowlist 이중 통제, 채널 참여는 P1 |
| 밀린 지시 일괄 실행 | M | 15분 처리 상한 + 안내 |
| edit 스트리밍이 change log 보존 한도 소모 | M | 기본 끔, rate limit |
| 공용 PG 용량(첨부) | L–M | 10 MiB 상한, 보존 기한, D-4 |
| tailnet 전용 origin에서 iOS 푸시 미동작 | **확인 필요** | H3 첫 작업으로 실기 시험, 실패 시 전환 기준 재정의 |
| Hermes 사용자 플러그인 로딩 세부(키 이름·Platform 동적 멤버) | L | homeassistant 사례 모방, 어댑터 레인에서 검증 |
| 클린룸 | L | Slack 코드·API 미사용, Hermes Slack 어댑터는 구조 이해용으로만 읽음, ohmyslack에 복사 0 |

## 6. 보안 경계 (요약 — 상세 행은 `dev/active/p1-hermes-adr/THREAT_MODEL-diff.md`)

1. **TB-8 (새)**: Hermes 어댑터 ↔ 봇 리스너 — 루프백 전용 포트, Bearer만, 쿠키·Origin 동봉 거부, `/api/bot/v1/**`만.
2. **TB-9 (새)**: 서버 → Web Push 서비스 — outbound HTTPS, 본문 없는 payload, endpoint 호스트 허용목록(SSRF 방지).
3. 메인 리스너 규칙은 **불변**: 쿠키 세션 + CSRF + Origin + Host 허용목록(`security.ts`, `guards.ts`).
4. 첨부: 매직 바이트 판정, SVG 금지, `sandbox` CSP, `nosniff`, `no-store`, SW 캐시 우회.
5. 로그: 봇 토큰·VAPID 개인키·push endpoint·첨부 바이트는 로그·계측 금지(TR-SEC-02·09 표식 확장).
6. 에이전트 권한 자체(맥에서 명령 실행)는 Hermes 승인 설정이 통제하며 ohmyslack 범위 밖입니다. ohmyslack은 「누가 지시했는가」의 서버 근거(`author_id`·`author_kind`)를 정확히 제공하는 책임만 집니다.

## 7. 단계별 도입 계획

| 단계 | 내용 | 완료 판정 | 의존 |
|---|---|---|---|
| H0 | 이 ADR·정본 개정안 채택 | 영환님 채택 | — |
| H1 | 봇 계정·토큰·봇 리스너·WS(서버), 서식 확장(웹), 어댑터(텍스트 대화·스레드=세션·승인 텍스트·브리핑 텍스트), Slack 병행 시작 | FR-BOT-01–06·FR-MSG-10 테스트 PASS, 영환님이 어댑터 배포·게이트웨이 재시작 후 Jarvis DM 왕복 1회 | H0 |
| H2 | 최소 첨부(서버·웹 오디오 플레이어·이미지 업로드), 어댑터 `send_voice`·`send_image_file`·수신 이미지 | FR-OPS-05 PASS, iPhone PWA에서 브리핑 mp3 재생 | H1 |
| H3 | Web Push(서버·SW·구독 UI), VAPID 키 생성(영환님 로컬 실행) | FR-CLIENT-05 PASS, tailnet origin 실기 수신 확인 | H1 (H2와 병렬 가능) |
| H4 | 병행 7일 관찰 → 전환 판정 → Slack 플랫폼 끄기(설정 보존) | §3-j 전환 기준 충족, 영환님 승인 | H2·H3 |

## 8. 영환님 결정 필요 (★ 권장 먼저)

결정 결과(2026-11-08): **D-1~D-7 모두 ★안 채택.** 아래 「결정(원문)」 열은 제안 당시 문장 그대로입니다.

| ID | 결정(원문) | 채택 결과 |
|---|---|---|
| D-1 | **D-1 ★ 플러그인 어댑터(A) 채택** — 대안 B는 브리핑 전달 불가, C는 목표 불충족. | **채택** — ★안 (2026-11-08 영환님) |
| D-2 | **D-2 ★ 새 P0를 기존 G1(MVP 게이트)에 포함**(P0 33 → 42) — 대안: Hermes 전용 게이트 GH를 따로 두고 G1은 33개 유지(그 경우 `check:fr-coverage`에 게이트 구분 표기 추가 필요). 어느 쪽이든 FR-BOT-04·06의 어댑터 측 동작은 vitest 지정 테스트가 될 수 없어(탐색 범위 5곳, DEV_DESIGN §2-1) 수동 증거 `QA-FR-BOT-0x`로 판정합니다. | **채택** — ★안 (2026-11-08 영환님) |
| D-3 | **D-3 ★ Web Push는 H4(전환)의 필수 요건, 구현은 H3** — 대안: 푸시 없이 전환(앱을 직접 열어 확인). | **채택** — ★안 (2026-11-08 영환님) |
| D-4 | **D-4 ★ 첨부 바이트를 PG `bytea`에 저장(10 MiB·오디오 30일 보존)** — 대안: 맥 로컬 디렉터리(백업 드릴 범위 확장 필요). | **채택** — ★안 (2026-11-08 영환님) |
| D-5 | **D-5 ★ 승인은 텍스트 명령(`/approve`·`/deny`)으로 시작, 버튼은 P1**. | **채택** — ★안 (2026-11-08 영환님) |
| D-6 | **D-6 ★ 어댑터 소스를 `integrations/hermes-plugin/`에 둠**(배포·재시작은 영환님). | **채택** — ★안 (2026-11-08 영환님) |
| D-7 | **D-7 ★ 봇 토큰 만료 없음 + 회전 CLI**, 밀린 메시지 처리 상한 15분 — 값 조정 가능. | **채택** — ★안 (2026-11-08 영환님) |

## 9. 사실 / 추정 / 확인 필요

- **사실**: §1-2·§1-3 표의 파일:행. Hermes 쪽 주요 5건(승인 텍스트 폴백, mp3→send_voice, api_server 비동기 전달 불가, Slack DM 최상위=세션 기본값, 승인 명령 문구)은 이 레인에서 원문을 직접 대조했습니다.
- **추정**: 시간 추정, 용량 추정, 리스너 분리의 검증 용이성, 푸시가 Slack 대체의 핵심이라는 판단.
- **확인 필요**: tailnet 전용 origin에서 iOS Web Push 구독·수신, iOS 오디오 Range 요구, 사용자 플러그인 `plugins.enabled` 키 이름, cron `deliver` 다중 대상, 브리핑 스레드 답글의 세션 연속성, Apple 경로의 RFC 8291 적용, 작성기의 `/` 입력 처리.
