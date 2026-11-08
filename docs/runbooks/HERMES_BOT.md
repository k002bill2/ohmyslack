# 런북 — Hermes 봇 계정·토큰·봇 리스너 운영 (W-18, FR-BOT, TR-SEC-13)

> 정본: TRD R3.3 §5-2(봇 인증·권한, ADR-001 §3) / `integrations/hermes-plugin/README.md` / `docs/runbooks/TAILSCALE_SERVE.md`.
>
> **이 문서는 적용을 승인하지 않습니다.** 봇 생성·토큰 발급·`BOT_PORT` 적용·Hermes 설정은 영환님이 직접 하거나 영환님 승인 후에만 합니다.
> 이 문서는 값을 담지 않습니다. `<token-id>`·`<slug>`·`<BOT_PORT>` 같은 자리표시자는 실행할 때 사람이 채웁니다.
> 토큰 원문(`omsb_` + 43자)을 이 문서·커밋·이슈·채팅·로그·QA 증거에 적지 않습니다.

명령 표기(**[조회·승인 필요]**·**[변경·승인 필요]**·**[로컬·승인 불필요]**)는 `TAILSCALE_SERVE.md` 표기 절과 같습니다.

## 0. 개요와 전제

- 봇 리스너는 사람용 메인 리스너와 다른 Fastify 인스턴스이며 `127.0.0.1:<BOT_PORT>`에만 바인드합니다. 등록 라우트는 `/api/bot/v1/**`뿐입니다.
  `GET me`, `GET conversations/{id}/messages`, `GET messages/{root_id}/replies`, `POST conversations/{id}/messages`, `PATCH messages/{id}`, `GET sync`, `GET sync/snapshot`, `PUT read-state`. WS `/api/bot/v1/ws`는 다음 레인(p1-w18b2) **예정**입니다.
- 봇은 참여 중인 대화(생성 시 만든 owner DM, owner가 추가한 채널)만 봅니다. 그 밖의 대화는 404입니다.
- 토큰은 `omsb_` + base64url 43자이며 DB에는 SHA-256만 저장합니다. 원문은 발급·회전 시 stdout에 **1회만** 나오고 다시 볼 수 없습니다. 만료 시각은 없습니다.

전제

1. 마이그레이션 적용(`0002_bots` 포함): `docs/runbooks/BOOTSTRAP_OWNER.md` 0절 3번.
2. 워크스페이스가 정확히 1개이고 활성 owner가 있어야 합니다(아니면 `no_workspace`·`multiple_workspaces`·`no_owner` 거부).
3. `DATABASE_URL`은 사람이 셸에서 직접 로드합니다(`BOOTSTRAP_OWNER.md` 0절 4번). 루프백 호스트가 아니거나 비어 있으면 종료 코드 2, 변경 없음.
4. 명령은 `apps/server/package.json`에 스크립트가 없어 아래 형식으로 부릅니다(**확인 필요**: 전용 스크립트가 생기면 교체).
   ```sh
   pnpm --filter @ohmyslack/server exec tsx bin/bot-admin.ts <명령>
   ```
   종료 코드: 0 성공 / 1 거부·DB 오류(변경 없음) / 2 사용법·입력 형식 오류(`invalid_slug`·`invalid_name`·`invalid_label` 포함, 변경 없음).

## 1. 봇 생성 (CLI)

1. **[변경·승인 필요]** `bot-admin.ts create --name <표시 이름> [--slug <slug>]`
   - slug 규칙: 소문자 영숫자로 시작, 영숫자·`-`만, 1–32자. 생략하면 표시 이름에서 유도합니다. 한글 이름처럼 유도 결과가 비면 `--slug`가 필요합니다.
   - 한 트랜잭션에서 봇 계정(`kind=bot`, role member)과 owner–봇 DM을 만듭니다. 같은 slug는 `slug_taken`.
   - 출력은 slug만 담습니다. **DM conversation id·owner user id는 출력하지 않습니다** → 3절 확인 후 5절에서 `/me`로 얻습니다.
2. **[조회·승인 필요]** `bot-admin.ts list` — `slug  status  미폐기 토큰 N개  표시 이름  봇 id` 줄로 확인합니다. 토큰 id는 나오지 않습니다.

## 2. 토큰 발급·회전·폐기·비활성화

봇당 미폐기 토큰은 **최대 2개**입니다. 2개 상태에서 발급·회전은 `token_limit`으로 거부됩니다.
`list`는 개수만 보여주므로 **발급·회전 출력 첫 줄의 토큰 id(`<token-id>`)를 기록**합니다(원문은 기록하지 않음).

발급

1. **[변경·승인 필요]** `bot-admin.ts token issue --bot <slug> [--label <라벨>]`(라벨 기본 `cli`, 1–64자).
2. 출력 첫 줄에 id, 마지막 줄에 원문이 나옵니다. 원문은 화면 공유·터미널 기록이 없는 상태에서 곧바로 Hermes `.env`(5절)로 옮기고 셸 히스토리·파일에 남기지 않습니다.

회전(순서를 지킵니다 — 어댑터는 401·403을 재시도하지 않는 fatal `unauthorized`로 처리하므로 옛 토큰을 먼저 폐기하면 끊깁니다)

1. **[조회·승인 필요]** `list`로 미폐기 토큰이 1개인지 확인합니다. 2개면 쓰지 않는 쪽을 먼저 `token revoke`합니다.
2. **[변경·승인 필요]** `bot-admin.ts token rotate --bot <slug>` — 새 id·원문과 폐기 대상 옛 id 목록이 나옵니다.
3. **[변경·승인 필요]** Hermes `.env`의 `OHMYSLACK_BOT_TOKEN`을 새 원문으로 교체 → `hermes gateway restart` → `hermes gateway status`에서 `ohmyslack` connected 확인.
4. **[조회·승인 필요]** 새 토큰으로 3절 `/me` 확인(200).
5. **[변경·승인 필요]** `bot-admin.ts token revoke --id <옛 token-id>` — 이후 옛 토큰은 401입니다.

폐기·비활성화

- **[변경·승인 필요]** `bot-admin.ts token revoke --id <token-id>` — 이미 폐기된 id는 성공(멱등), 없는 id는 `no_such_token`.
- **[변경·승인 필요]** `bot-admin.ts disable --bot <slug>` — 봇을 비활성화하고 미폐기 토큰을 모두 폐기합니다. **되돌리는 명령이 없습니다**(영구 퇴역용). 비활성 봇의 발급은 `bot_disabled`.
- 열린 봇 WS를 폐기·비활성화 후 5초 안에 닫는 동작은 WS 레인(p1-w18b2)과 함께 **예정**입니다.

## 3. `BOT_PORT` 설정과 재기동

계약(서버 구현 기준)

- `BOT_PORT`(1–65535)가 없거나 비면 봇 리스너를 **시작하지 않습니다**(기본 꺼짐, 기존 운영 무변경).
- `BOT_PORT == PORT`이면 서버가 기동을 거부합니다. `HOST`가 루프백이 아니면 기동을 거부합니다(메인과 같은 가드).
- Host 헤더 허용목록: `127.0.0.1:<BOT_PORT>`·`localhost:<BOT_PORT>`.

적용

1. **[변경·승인 필요]** 운영 환경변수에 `BOT_PORT=<BOT_PORT>`를 사람이 추가합니다(에이전트는 운영 `.env`를 열지 않습니다). `PORT`와 다른 값을 씁니다.
2. **[변경·승인 필요]** 서버를 재기동합니다(`TAILSCALE_SERVE.md` 1절과 같은 방법).
3. **[조회·승인 필요]** 리스너 확인: `lsof -nP -iTCP -sTCP:LISTEN | grep ':<BOT_PORT>'` → `127.0.0.1:<BOT_PORT>` 1줄. `*:`·`0.0.0.0:`·`[::]:`·LAN IP면 중단하고 7절 롤백.
4. **[조회·승인 필요]** 인증 확인(토큰은 사람이 셸에 직접 로드한 env로만 넘깁니다. `-v`·`set -x` 금지 — Authorization 헤더가 출력됩니다):
   ```sh
   curl -s -H "Authorization: Bearer $OHMYSLACK_BOT_TOKEN" http://127.0.0.1:$BOT_PORT/api/bot/v1/me
   ```
   기대: 200, 봇 id·`owner_user_id`·참여 대화 id 목록(생성 직후에는 owner DM 1개). 응답에 토큰은 없습니다.

## 4. Tailscale Serve 점검 (점검만)

봇 포트는 **Serve·Funnel에 절대 넣지 않습니다.** 이 절은 조회만 하며 설정 변경 명령을 쓰지 않습니다.

1. **[조회·승인 필요]** `tailscale serve status` — 출력에 `<BOT_PORT>`가 **없어야** 합니다. 대상은 메인 앱 `127.0.0.1:<port>` 하나뿐입니다.
2. **[조회·승인 필요]** `tailscale funnel status` — 공개 항목 0건.
3. `<BOT_PORT>`가 보이면 봇 사용을 멈추고 `TAILSCALE_SERVE.md` 6절(롤백)을 따른 뒤 7절로 갑니다.

## 5. 어댑터 env 연결 (Hermes `.env`, 이 저장소에는 값을 남기지 않음)

| 이름 | 값 |
|---|---|
| `OHMYSLACK_BOT_URL` | `http://127.0.0.1:<BOT_PORT>`. **http + 루프백(`127.0.0.1`·`localhost`) + 포트**만, 경로·쿼리·사용자 정보 없이. 그 밖이면 fatal `config_invalid`. 없으면 `OHMYSLACK_BOT_PORT`로 대체 가능 |
| `OHMYSLACK_BOT_TOKEN` | 2절에서 받은 원문. 어댑터는 Hermes 비밀 저장 규칙으로만 읽고 로그에 남기지 않습니다 |
| `OHMYSLACK_HOME_CHANNEL` | owner DM conversation id(3절 `/me`의 참여 대화 id). cron `deliver=ohmyslack` 대상 |
| `OHMYSLACK_ALLOWED_USERS` | owner user id(3절 `/me`의 `owner_user_id`). Hermes 인가 계층에도 같은 owner를 넣어 어댑터 author_id 필터와 이중 방어 |

- 어댑터는 `/me`의 `conversation_ids` 키로 참여 대화를 읽습니다. 서버 응답 키 이름은 서버 구현과 대조합니다(**확인 필요**).
- 설치·활성화·재시작 절차는 `integrations/hermes-plugin/README.md` 배포 절차를 따릅니다.

## 6. 장애 대응

| 증상 | 원인 | 조치 |
|---|---|---|
| 연결 거부(connection refused) | `BOT_PORT` 미설정·서버 미재기동·포트 불일치 | 3절 1–3번 |
| 400 | 요청에 `Origin` 또는 `Cookie` 헤더가 있음(브라우저발 차단) | 브라우저·쿠키 jar 경유 호출 중단. curl·어댑터는 Bearer만 |
| 401 | 토큰 없음·형식 오류·폐기·봇 비활성화(모두 같은 본문) | `list`로 상태 확인 → 필요 시 2절 발급·회전 후 `.env` 교체 |
| 404 | 봇이 참여하지 않은 대화(존재 은폐)·잘못된 conversation id | `/me` 참여 목록과 대조. 채널이면 owner가 웹에서 봇 추가 |
| 429 | 토큰별 제한 초과(생성 30건/분, 수정 60건/분) | `Retry-After`만큼 대기(어댑터는 최대 60초 자동 대기) |
| 어댑터 fatal `config_invalid` | `OHMYSLACK_BOT_URL`이 루프백 http+포트가 아님 | 5절 형식으로 수정 |

## 7. 롤백

1. **[변경·승인 필요]** Hermes에서 `ohmyslack` 플러그인을 멈춥니다(README 절차 역순).
2. **[변경·승인 필요]** 운영 환경변수에서 `BOT_PORT`를 제거하고 서버를 재기동합니다.
3. **[조회·승인 필요]** `lsof -nP -iTCP -sTCP:LISTEN | grep ':<BOT_PORT>'` 0줄, `curl -s http://127.0.0.1:<BOT_PORT>/api/bot/v1/me`가 연결 거부인지 확인 → 봇 리스너 없음.
4. **[변경·승인 필요]** 유출 의심 등 필요 시 `bot-admin.ts token revoke --id <token-id>`로 해당 토큰을 폐기합니다. 봇을 영구 퇴역할 때만 `disable`(되돌릴 수 없음).
5. 메인 리스너·Serve 설정은 이 절차로 바뀌지 않습니다. `tailscale serve status`로 4절 기대와 같은지 다시 확인합니다.

## 8. 봇 WS(`/api/bot/v1/ws`)와 연결 닫기 (W-18b2)

- 연결: `ws://127.0.0.1:<BOT_PORT>/api/bot/v1/ws`, 헤더 `Authorization: Bearer <토큰>`만. `Origin`·`Cookie`가 있으면 업그레이드 400, 토큰 없음·무효는 401(서버가 소켓을 닫는다). URL에 토큰을 넣지 않는다.
- 프레임: 사람 `/api/ws`와 같은 shared 스키마(`conversation.subscribe` → `conversation.subscribed`/`message.*`/`read.updated`/`error`/`sync.required`). 봇이 참여한 대화만 전달되고, 대화에서 빠지면 다음 전달 직전 재확인에서 `error(not_found)`로 구독이 끝난다.
- 닫기: 토큰 폐기·회전 후 옛 토큰 폐기·봇 비활성화 → **close 1008, 사유 `token_revoked`**. CLI는 별도 프로세스라 봇 리스너가 2초 주기 sweep(열린 연결의 토큰 ID 전체를 쿼리 1회로 재검증)으로 잡는다 — 최악 지연 ≈ 2초 + 쿼리 1회(5초 보장). 같은 프로세스에서 일어난 폐기는 이벤트로 즉시 닫힌다.
- 어댑터는 1008을 받으면 재연결을 멈추고 로그만 남긴다(토큰 교체 필요). 1001(서버 종료)·네트워크 끊김은 재연결한다.
- 확인: `bot-admin disable` 후 어댑터 로그에 1008 `token_revoked`가 5초 안에 찍히는지 본다.

## 9. 실서버 E2E(어댑터 ↔ 봇 리스너, 테스트 DB 전용)

- 스크립트: `integrations/hermes-plugin/scripts/live-e2e.sh`. 테스트 DB(`.env.test`)에 실행별 스키마를 만들고 서버를 `BOT_PORT`로 띄운 뒤 CLI로 봇·토큰을 만들고 `pytest -m live`를 1회 돌린 다음 서버·스키마를 정리한다. 값(토큰·DB URL)은 출력하지 않는다.
- 운영 DB·운영 `.env`로는 실행하지 않는다. Hermes 본체(`~/.hermes/hermes-agent`)는 import만 한다.
