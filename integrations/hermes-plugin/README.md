# ohmyslack Hermes 플랫폼 플러그인 (W-20)

Hermes 게이트웨이가 ohmyslack **봇 리스너**(`127.0.0.1:<BOT_PORT>/api/bot/v1`)에 붙어서 owner의 Jarvis DM 지시(와 owner가 봇을 추가한 채널에서 봇을 멘션한 지시)를 Hermes 세션으로 넘기고, 응답을 같은 스레드에 게시하는 플러그인입니다.
정본: ADR-001 §3, TRD R3.3 §5-2, DEV_DESIGN W-20, 채널은 `docs/09-specs/BOT_CHANNEL_SPEC.md` §5.

## 배포 절차 (영환님)

1. 서버에서 봇 계정과 토큰을 발급합니다. 발급 도구는 `apps/server/bin/bot-admin.ts`이고, 토큰은 `omsb_…` 형식이며 발급할 때 한 번만 출력됩니다.
2. 플러그인을 **봇을 돌릴 프로필의 plugins 디렉터리**에 설치합니다. `~/.hermes/plugins/`는 default 프로필 전용이라, 다른 프로필(예: `jarvis`)은 `~/.hermes/profiles/<profile>/plugins/<name>`에 두어야 로드됩니다. 다음 둘 중 하나를 고릅니다(`<profile>`은 실제 프로필 이름).
   - 링크: `ln -s "$PWD/integrations/hermes-plugin/ohmyslack" ~/.hermes/profiles/<profile>/plugins/ohmyslack`
   - 복사: `cp -R integrations/hermes-plugin/ohmyslack ~/.hermes/profiles/<profile>/plugins/ohmyslack`
   - default 프로필에서만 돌릴 때는 `~/.hermes/plugins/ohmyslack`입니다.
   - 확인: `hermes -p <profile> plugins list --plain --no-bundled`에 `ohmyslack`이 보여야 합니다.
3. 같은 프로필의 Hermes `.env`(default가 아니면 `~/.hermes/profiles/<profile>/.env`)에 아래 env 값을 넣습니다. 이 저장소에는 값을 남기지 않습니다.
4. `hermes -p <profile> plugins enable ohmyslack`을 실행합니다(default 프로필이면 `-p <profile>` 생략). 이 명령은 config.yaml의 `plugins.enabled`에 이름을 추가합니다. bundled가 아닌 플러그인이라 capability 동의 절차가 한 번 나옵니다.
5. 같은 프로필의 게이트웨이를 재시작합니다(`hermes -p <profile> gateway restart` 또는 평소 쓰는 방법). 재시작 후 `hermes -p <profile> gateway status`에 `ohmyslack`이 connected로 표시되는지 확인합니다.

## env

| 이름 | 필수 | 설명 |
|---|---|---|
| `OHMYSLACK_BOT_TOKEN` | 예 | 봇 토큰. Hermes 비밀 저장 규칙(`get_scoped_secret`)으로만 읽고, 로그에는 남기지 않습니다 |
| `OHMYSLACK_BOT_URL` | 둘 중 하나 | 예: `http://127.0.0.1:<BOT_PORT>`. **루프백(`127.0.0.1`·`localhost`) + http + 포트**만 허용하며, 그 외 값이면 연결을 거부합니다(fatal `config_invalid`) |
| `OHMYSLACK_BOT_PORT` | 둘 중 하나 | URL이 없을 때 `http://127.0.0.1:<port>`로 씁니다 |
| `OHMYSLACK_HOME_CHANNEL` | 권장 | cron `deliver=ohmyslack`의 대상인 Jarvis DM conversation id입니다. DM 또는 `OHMYSLACK_POST_CHANNELS`에 든 채널만 됩니다 — 그 밖의 채널 id면 standalone 전송을 거부합니다 |
| `OHMYSLACK_POST_CHANNELS` | 아니오 | 최상위 게시를 허용할 채널 conversation id 목록(쉼표 구분, 공백·빈 항목 무시, UUID 아닌 항목은 무시하고 개수만 경고). `/me`에서 channel로 확인된 대화에만 적용됩니다. 미설정이면 채널 최상위 송신 0(기존 동작). 2026-11-19 브리핑 채널용(BOT_CHANNEL_SPEC §5-5·§5-6) live 어댑터는 시작 때 1회 읽으므로 값을 바꾸면 게이트웨이를 재시작해야 합니다(cron standalone은 호출마다 읽음). |
| `OHMYSLACK_ALLOWED_USERS` | 권장 | owner user id입니다. Hermes 인가 계층에도 같은 owner를 넣습니다. 어댑터의 author_id 필터와 함께 이중 방어가 됩니다 |

커서 파일은 `~/.hermes/ohmyslack/cursor.json`(Hermes 홈 하위)에 저장합니다. 담는 값은 숫자 `change_id`, 저장 시각, 최근 처리한 message id뿐이고 본문과 토큰은 넣지 않습니다.

## 동작 요약

- **연결**
  - 순서: `GET /me`(봇·owner id, 표시 이름, `conversations[].kind`) → cursor가 있으면 `GET /sync?after=` 페이지 catch-up → WS `/api/bot/v1/ws` → 참여 대화마다 `conversation.subscribe{after_cursor}`
  - cursor가 없거나 410을 받으면 대화별 `GET /sync/snapshot`으로 초기화하고, 그 `snapshot_cursor`부터 catch-up합니다
  - 헤더는 `Authorization: Bearer`만 보냅니다. Origin·Cookie는 보내지 않으며 cookie jar도 쓰지 않습니다
- **재연결**
  - 2→4→…→60초 지수 백오프에 지터(최대 +10%)를 더합니다
  - 401·403을 받으면 재시도하지 않고 fatal `unauthorized`로 처리합니다
- **인바운드**
  - `message.created`만 처리합니다
  - owner 판정은 `author_id == me.owner_user_id`만으로 합니다. 본문은 보지 않습니다
  - 자기 echo와 중복 id는 버립니다. 중복 판정에는 `MessageDeduplicator`와 cursor 파일의 최근 id를 함께 씁니다
  - `created_at`이 15분을 넘은 지시는 실행하지 않습니다. 대신 대화별로 「오프라인 동안 받은 N건은 처리하지 않았습니다」를 1건 게시합니다
  - 최상위 메시지는 `thread_id = message.id`로 새 세션이 되고, 답글은 `thread_id = thread_root_id`로 같은 세션에 붙습니다
  - `/approve`·`/deny`는 해석하지 않고 원문 그대로 Hermes에 넘깁니다
- **채널**(BOT_CHANNEL_SPEC §5)
  - `/me.conversations`의 종류로 `chat_type`을 `dm`/`channel`로 넘깁니다. `/me`에 없는 대화의 메시지는 무시합니다. `conversations`가 없는 `/me`(구 서버)는 연결 실패로 처리합니다
  - 판정 순서: owner 작성자 → 대화 종류·멘션 → 중복 → 15분 상한. DM은 기존 동작 그대로입니다
  - 채널에서는 **답글을 포함한 모든 메시지**가 서버 `mention_user_ids`에 봇을 담고 있어야 실행합니다. 본문 `@이름` 문자열은 판정에 쓰지 않습니다. 멘션 없는 owner 글은 실행·백로그 집계 없이 중복 방지 기록만 합니다. 수정된 글(`edited_at`)은 실행하지 않습니다
  - Hermes에 넘기기 전 본문 **맨 앞** `@<봇 표시 이름>` 토큰 1개만 지우고 공백을 다듬습니다(`@Jarvis /approve` → `/approve`)
  - 세션: 채널 최상위 = 새 세션(`…:channel:<대화>:<message.id>`), 답글 = 루트 세션
  - 송신은 **스레드 답글로만** 합니다. 루트를 모르는 채널 송신(첨부 포함)은 보내지 않고 로그만 남깁니다. 예외: `OHMYSLACK_POST_CHANNELS` 채널은 최상위(live·standalone, 첨부 포함)도 보냅니다 4000자를 넘는 최상위 게시는 첫 조각만 최상위로 올리고 나머지 조각은 첫 조각의 스레드 답글로 묶입니다(첫 조각 id를 못 얻으면 남은 조각은 최상위로 보내고 경고만 남김. DM 분할은 그대로 연속 최상위).
  - `OHMYSLACK_POST_CHANNELS` 채널에서 봇이 쓴 최상위 글(브리핑) 스레드에 owner가 멘션 없이 답하면 그 스레드 세션으로 넘깁니다. 다른 채널의 봇 글 스레드·비owner 답글은 무시합니다
  - 15분을 넘긴 채널 지시의 안내는 채널이 아니라 홈 DM에 「오프라인 동안 받은 N건은 처리하지 않았습니다 (<대화 id>)」로 1회 보냅니다
  - 멤버십: WS `membership.changed joined` → `/me` 재조회 후 그 대화만 현재 watermark로 구독(재연결 없음). `left`·`error not_found` → 대화 맵·구독 목록에서 제거, 이후 그 대화 프레임은 무시합니다. `sync.required`는 `/me`를 다시 읽은 뒤 재구독합니다. catch-up에 `/me`에 없는 대화가 보이면(참여 직후 경쟁) 처리 전에 `/me`를 다시 읽습니다
- **아웃바운드**
  - `POST /conversations/{id}/messages`로 게시합니다. 답글이면 루트로 보정한 `thread_root_id`를 붙입니다
  - `client_message_id`를 고정해 멱등 재시도합니다. 429면 `Retry-After`(최대 60초)를 따르고, 5xx와 연결 오류도 재시도합니다
  - 4,000 code point를 넘으면 나눠 보냅니다(base `truncate_message`, 코드펜스 보존)
    - cron 전달(live 레인)도 포함합니다. 어댑터가 `splits_long_messages = True`를 선언해 Hermes 라우터(`gateway/delivery.py` `_cap_oversized_output`)가 4,000자 초과 출력을 `... [truncated, full output saved to …]`로 자르지 않고 전문을 넘깁니다(전문 사본 `cron/output/` 저장은 그대로). 긴 출력은 조각마다 1건씩, DM 최상위면 연속 최상위·스레드면 같은 스레드에 게시돼 조각마다 알림이 갑니다
  - `edit_message`는 PATCH로 처리합니다. 스트리밍은 Hermes 설정을 따르며 기본은 꺼짐입니다
  - 첨부(W-20 H2, ADR-001 §3-g): `send_voice`(mp3)·`send_image_file`(png·jpeg·webp, 파일당 10 MiB)은 `POST /attachments` 업로드 후 `attachment_ids`로 메시지를 만듭니다(본문 = caption, 없으면 파일명). 허용 밖 형식·10 MiB 초과·심볼릭 링크·디렉터리·없는 경로·업로드 실패는 텍스트 대체 안내로 보냅니다. 업로드 뒤 메시지 생성이 실패하면 대체 게시하지 않고(중복 방지) 미결속 첨부는 서버가 1시간 뒤 정리합니다. 문서·영상은 텍스트 대체(FR-OPS-09 P1). 수신은 사람 메시지의 이미지 첨부를 봇 토큰으로 받아 Hermes 이미지 캐시에 두고 이벤트 미디어로 넘깁니다(실패 시 텍스트만). 오디오 수신은 아직 넘기지 않습니다. 로그에는 경로·본문·캡션을 남기지 않습니다(첨부 ID만)
- **standalone sender**: 게이트웨이 밖에서 도는 cron이 같은 HTTP 클라이언트로 홈 채널에 **최상위** 메시지를 보냅니다
  - **단일 호출 계약**: 플랫폼을 `max_message_length=0`으로 등록합니다. 그래서 Hermes는 원문을 쪼개지 않고 원문 전체와 첨부 전체를 sender **한 번** 호출에 넘깁니다(Hermes `gateway/outbound/send.py` `_platform_max_length`, 이 등록값을 읽는 유일한 곳 — 2026-11-16 이전 `tools/send_message_tool.py`). `/me`도 한 번, deadline도 하나입니다. 4,000 code point 청크 분할(`(i/n)` 표기 포함)은 어댑터 안에서 합니다. 라이브 어댑터 경로도 어댑터가 같은 함수로 나누므로 게시 형태는 같습니다
  - 첨부(ADR-002 1a): `media_files`의 mp3·png·jpeg·webp는 라이브 경로와 같은 판정·상한(파일당 10 MiB, 메시지당 4개)으로 업로드해 텍스트의 **첫 청크**에 결속합니다(본문이 비면 첫 파일명). 모든 첨부가 결속되면 `media_delivered: True`를 함께 돌려줍니다. 라이브 경로(`send_message` → 텍스트 뒤 별도 미디어 메시지)와 첨부 위치가 다른 것은 알려진 차이입니다
  - 라이브 경로 후속 첨부(#52): `OHMYSLACK_POST_CHANNELS` 채널에서 caption·루트 없는 첨부(`send_voice`·`send_image_file`, 대체 글 포함)가 60초(`MEDIA_FOLLOW_WINDOW_SECONDS`) 안 **유일한** 최상위 본문 뒤에 오면, 새 최상위 글 대신 그 본문 첫 조각 스레드에 별도 답글로 붙습니다. 첫 청크 결속은 여전히 standalone만 합니다
  - 창 안 최상위 글이 2개 이상(모호)·창 초과·caption 있음·루트 지정·DM·직전 최상위가 첨부 글이면 기존 동작(최상위 또는 지정 루트)입니다
  - 파일 검사·읽기는 daemon 스레드 1개에서 한 번만 합니다(`O_NOFOLLOW` open → `fstat`으로 사유 판정, 이벤트 루프 스레드의 파일 시스템 호출 없음). 멈춘 파일 시스템 읽기가 있어도 Hermes `asyncio.run` 종료가 그 스레드를 기다리지 않습니다
  - 지원 밖 형식(문서·영상 등)·없는 파일·상한 초과·업로드 실패·4개 초과(지원 형식 앞 4개만 시도)·시간 예산 초과는 업로드하지 않고 파일마다 `warnings`에 `"<파일명>: <사유>"` 한 줄(`unsupported_type`·`not_found`·`too_large`·`rejected`·`upload_failed`·`too_many`·`budget_exceeded`·`read_unavailable`)을 싣습니다. 텍스트는 그대로 보냅니다
  - 시간: 전송 전체(`/me`·파일 읽기·업로드·청크 게시와 재시도)는 시작부터 **25초**(`STANDALONE_TOTAL_DEADLINE_S`) 안에서만 합니다. 예약은 시작 시각 기준 절대 deadline(`_BUDGET_SPLIT`, TOTAL 하나에서 파생): `/me` 3초 · `/me`+읽기+업로드 15초 · 게시·재시도 20초 · 확인 GET 23초(게시가 끊겨도 확인 가능) · `session.close()` 25초. 바깥은 `asyncio.timeout(25)` 백스톱이고 정리 실패·포기는 확인된 전송 결과를 바꾸지 않습니다. **25초는 협조적 취소 전제**입니다 — 취소를 억제하는 정리, 루프를 막는 동기 작업, `asyncio.run` 종료 시간은 보장 밖입니다. `localhost` 주소는 standalone에서 `127.0.0.1`로 바꿔 resolver 스레드를 피합니다. 남은 시간보다 긴 재시도 대기(429 `Retry-After` 등)는 기다리지 않습니다. 25초는 Hermes 폴백 분기(실행 중인 루프 안에서 불릴 때 30초)보다 짧게 잡은 값이지만, 그 30초 안 종료를 증명하지 않으므로 폴백 이중 게시(R3-a)를 막는다고 단정하지 않습니다 — 열린 위험입니다. **Hermes `cron.standalone_send_timeout_seconds`가 기본 60초라고 가정합니다** — 25초 밑으로 낮추면 Hermes 취소가 먼저 와서 아래 보고가 사라집니다
  - 결과 규칙: 청크를 하나도 못 올리면 `send_error`(모인 첨부 사유 포함, `deadline_exceeded`·`HTTP <status>` 등)입니다. 첫 청크가 확정 거부(rejected)로 끝난 경우에만 아무것도 나가지 않았으므로 Hermes 재전달 큐가 안전합니다(첫 청크 `delivery_unknown`·`idempotency_conflict`는 아래처럼 중복 위험이 남습니다). 청크 k개(≥ 1)를 올린 뒤 실패하거나 deadline이 지나면 `success: True` + `warnings`의 `text: partial_delivery <k>/<n>`입니다. 오류로 돌려주면 Hermes 재전달 큐가 원문 전체를 다시 보내 앞 청크가 중복되므로, **중복 대신 보이는 꼬리 유실**을 택합니다(첫 청크에 첨부가 결속되므로 첨부는 전달됨). Hermes cron은 `warnings`를 전달 오류(`delivery warning: …`)로 올립니다. 첫 게시가 확정 거부(4xx)로 끝나면 아무것도 저장되지 않아 Hermes 재전달이 안전합니다. 응답이 끊겨 저장 여부를 모르면 플러그인은 같은 키로 다시 보내고, 그래도 모르면 봇 이력에서 키를 찾아 확인합니다. **확인까지 실패하면 `delivery_unknown` 오류를 돌려주며, 이때 Hermes 재전달로 같은 메시지가 한 번 더 올라갈 수 있습니다. 이 위험은 해결되지 않았고 수용된 것입니다(2026-11-14).** `media_delivered: True`는 첨부가 모두 업로드되고(파일 경고 0) 첫 청크가 확인됐을 때만 붙고, 뒤 청크의 텍스트 경고와는 무관합니다
  - 재시도 표시(N-2): 아무것도 보내지 않은 실패(토큰·홈 채널 없음, URL 오류, 대상 거부, `/me` 실패, 첫 게시 전 deadline — 어떤 청크도 게시 시도 전)는 `retryable: True`(Hermes `send_error(..., nothing_sent=True)`)로 알립니다. 게시를 한 번이라도 시도한 뒤의 실패(확정 4xx 포함, `delivery_unknown`, `idempotency_conflict`)는 재시도 표시 없이 오류입니다. `nothing_sent`를 모르는 구 Hermes에서는 재시도 표시 없는 오류로 폴백합니다. `retryable: True`는 「아무것도 나가지 않음」 표시일 뿐이며, 실제 재전달 여부는 Hermes 큐 정책을 따릅니다(관측: Hermes `caafe538`에서 `retryable`을 이름으로 읽는 곳은 live 전달 경로 `gateway/delivery.py`·`cron/scheduler_delivery.py` `_live_send_text` 등이고, standalone 전달 함수는 읽지 않음)
  - 확인 한계: 봇 이력 확인 GET은 최상위 메시지만 보므로, `OHMYSLACK_POST_CHANNELS` 채널에서 스레드 답글로 묶인 두 번째 이후 조각의 응답이 끊기면 확인하지 않고 `partial_delivery` + `delivery_unknown chunk <i>` 경고로 보고합니다(성공으로 숨기지 않음)
  - 남은 위험(플러그인만으로는 못 막음, Hermes 본체 변경 제안은 별건):
    - A-1: Hermes 바깥 상한을 25초 밑으로 설정하면 어댑터 deadline보다 먼저 취소됩니다. 이때 warnings·부분 보고가 사라지고, 부분 게시 상태면 재전달 큐 중복이 생길 수 있습니다
    - A-2: 재전달 큐는 부분 게시를 모릅니다. 정상 반환은 위 규칙으로 피하지만, 취소 경로(바깥 타임아웃·프로세스 종료)에서는 보고할 기회가 없습니다
    - A-3: 결정적 멱등 키를 만들 수 없습니다. Hermes가 실행 단위 ID를 넘기지 않아, 원문 해시 키는 같은 문구를 반복하는 cron을 조용히 삼킵니다. 멱등 범위는 "게시 호출 1회 안의 재시도"뿐입니다
    - A-4: 멈춘 파일 시스템 읽기 스레드 자체는 죽일 수 없습니다. 멈춘 파일 읽기 스레드는 프로세스 전체에서 최대 4개입니다(fd 1개씩 점유하는 상한 있는 누수). 슬롯이 다 차 있으면 그 파일은 읽지 않고 standalone은 `"<파일명>: read_unavailable"` 경고, 라이브 첨부는 고정 안내("첨부 파일을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.")를 텍스트로 보냅니다. 읽기 스레드는 실제 읽기가 끝난 뒤 슬롯을 먼저 반환하고 그다음 결과를 알리므로, 결과를 받은 호출의 다음 읽기는 그 슬롯을 쓸 수 있습니다
  - `thread_id`·`force_document`는 쓰지 않습니다. 대상이 DM이 아니면 업로드도 하지 않고 거부합니다

## Hermes 확인 항목 (ADR REPORT §8 3–6)

경로는 `~/.hermes/hermes-agent` 기준입니다. 2026-11-08에 읽어서 확인했습니다.

1. **`plugins.enabled` 키**: 확인됨.
   - 유저 플러그인은 opt-in입니다. config.yaml `plugins.enabled` 허용 목록에 있어야 로드되고, `plugins.disabled`가 우선합니다(`hermes_cli/plugins_discovery.py:112-131`, 미등록 시 건너뛰기 `:320-324`).
   - `hermes plugins enable <name>`은 `plugins.enabled`에 이름을 넣고 `plugins.disabled`에서는 뺍니다(`hermes_cli/plugins_cmd.py:657-662, 713-747`).
2. **`Platform("ohmyslack")`**: 확인됨.
   - `Platform._missing_`은 bundled 플랫폼이거나 `platform_registry.is_registered(value)`일 때만 pseudo-member를 만듭니다(`gateway/config.py:244-276`).
   - 그래서 `register(ctx)`로 등록한 다음에만 해석됩니다. 테스트 `test_platform_resolves_after_registration`이 이 동작을 확인합니다.
3. **cron 다중 deliver**: 확인됨.
   - `deliver`는 콤마 문자열과 list를 모두 받고, 대상마다 따로 전달합니다(`cron/scheduler_delivery.py:795-805, 874-906`, 설명 `tools/cronjob_tools.py:1162`). 따라서 `deliver="slack,ohmyslack"`로 병행 기간에 두 곳에 보낼 수 있습니다.
   - 홈 채널은 `cron_deliver_env_var`(`OHMYSLACK_HOME_CHANNEL`)로 정하고, 값이 없으면 config `home_channel`을 씁니다(`cron/scheduler_delivery.py:394-403, 451-472`).
   - standalone 호출 계약은 `gateway/platform_registry.py:107-110`이고, 호출부는 `tools/send_message_tool.py:594`입니다.
4. **브리핑 스레드 세션 연속성**: 부분 확인, 런타임은 미확인.
   - cron 작업 자체는 항상 새 세션에서 돕니다.
   - 게이트웨이가 살아 있는 경로에서는 `mirror_this_target`이 참일 때만 전달 메시지로 새 gateway 세션을 seed합니다(`cron/scheduler_delivery.py:1404-1437`). 이 값은 origin 대상이거나 `cron.mirror_delivery`·작업별 opt-in일 때만 참이고 기본은 거짓입니다(`:90-150`).
   - 그래서 기본 설정에서 브리핑에 단 답글은 **브리핑 내용을 모르는 새 세션**이 될 가능성이 큽니다. 어댑터는 답글의 `thread_root_id`(브리핑 메시지 id)를 thread_id로 넘깁니다.
   - standalone 경로에는 seed가 없습니다(`:1643-1648`).
   - 연속성이 필요하면 `cron.mirror_delivery` opt-in을 검토해야 합니다. 이 항목은 실제 게이트웨이에서 확인이 필요합니다.

## 개발·테스트

```bash
cd integrations/hermes-plugin
uv venv .venv --python ~/.hermes/hermes-agent/venv/bin/python3.11
uv pip install --python .venv/bin/python pytest pytest-asyncio aiohttp pyyaml ruamel.yaml
bash scripts/isolated-pytest.sh --preflight   # 직접 pytest 실행 금지 — 아래 「격리 테스트 실행」
```

- 테스트는 가짜 aiohttp 봇 서버를 상대로 돌고, `HERMES_HOME`을 tmp로 격리합니다. 실제 서버나 게이트웨이에는 연결하지 않습니다.
- Hermes 본체는 `PYTHONPATH`로 읽기만 하며, 설치하거나 복사하지 않습니다.
- 실서버 live 테스트(`-m live`, 기본 실행에서 제외)는 `scripts/live-e2e.sh`가 준비한 테스트 스키마·임의 포트 서버만 상대합니다(운영 8787/8788 금지). `tests/test_live_e2e.py`는 owner 메시지 왕복, `tests/test_live_standalone.py`(Issue #47)는 standalone 긴 텍스트 + mp3 실발송(청크 수·순서·첫 청크 첨부 결속·`media_delivered`)과 가짜 서버 400/404 규칙의 실서버 대조(상태·오류 코드)입니다.
- `scripts/live-e2e.sh` 마지막 단계는 pytest 를 직접 부르지 않고 격리 래퍼 `scripts/isolated-pytest.sh --run-live` 를 한 번 부릅니다(가드가 래퍼 밖 실행을 EXIT 3 으로 끊으므로). 래퍼가 G3 해시 게이트(`--run-attested` 와 같음, 불일치 EXIT 5)와 live env 검증(`OHMYSLACK_LIVE_E2E=1`, URL 3개는 정확히 `http://127.0.0.1:<1024-65535>`·운영 포트 아님, 토큰·쿠키·CSRF 는 비어 있지 않은 한 줄 — 위반 EXIT 64, 값 비공개)을 거친 뒤 sandbox 안에서 `-q -m live tests/test_live_e2e.py tests/test_live_standalone.py` 만 돌립니다.
- 비밀(토큰·쿠키·CSRF)은 argv 에 싣지 않습니다: 래퍼가 `.isolation/` 아래 0600 새 파일로 옮기고 sandbox env 에는 `*_FILE` 경로만 넘기며, 종료 때 지웁니다(SIGKILL·전원 차단이면 다음 래퍼 실행의 `.isolation/` 재생성 때까지 0700 디렉터리에 남음). 테스트가 실패하면 pytest 출력은 `.isolation/tmp/run-live.out`에도 남습니다. owner 메시지 게시는 테스트 프로세스 안 aiohttp 요청입니다(sandbox 가 subprocess 를 막음, `scripts/live_owner_send.py` 는 미사용).

## 격리 테스트 실행 (설계 r4 §Q5 · 단계 1)

`P/tests` 는 autouse session fixture 가 Hermes 를 import 하므로 **래퍼 밖에서 직접 돌리지 않습니다**.
`tests/conftest.py` 맨 앞 가드가 래퍼 표지·격리 env 없는 실행을 EXIT 3(`OHMYSLACK-ISOLATION-GUARD-REFUSED`)으로 끊습니다.
가드는 보조 장치이고, OS 수준 차단은 `scripts/pytest.sb`(sandbox-exec 사용자 정의 프로필)의 몫입니다.

- 구성: `scripts/isolated-pytest.sh`(env -i 허용목록 + sandbox-exec), `scripts/pytest.sb`(템플릿 → `.isolation/profile.sb` 렌더링),
  `tests/_isolation_guard.py`(순수 함수 가드), `tests_isolation/`(Hermes import 0 점검), `probe_outside/`(사람 전용, 기본 수집 제외 — 이름을 `test*` 로 시작하지 않아 pytest 가 그 conftest 를 자동으로 읽지 않음).
- `.isolation/` 은 실행마다 래퍼가 지우고 다시 만듭니다(gitignore). 지우기 전에 경로·하위가 symlink 가 아니고 realpath 가 기대값인지 확인하고, 어긋나면 아무것도 지우지 않고 EXIT 2. 삭제는 symlink 를 따라가지 않는 `find -P … -delete`(`scripts/_iso_fs.sh`), 재생성은 새 `mkdir`. 회귀: `bash scripts/iso-symlink-regress.sh <worktree 안 대상 디렉터리>` → `SYMLINK-REGRESS PASS`.
- 거부 포트 줄은 래퍼의 `DENY_PORTS=(8787 8788)` 한 목록에서 생성됩니다(사람 실행 `--prove-outside` 때만 임의 포트 X 추가).
- `--prove-outside` 의 TTY·확인 인자·`/dev/tty` 난수 왕복 장치는 **우발 실행 방지**일 뿐입니다. 의도적 우회는 막지 못합니다.
- 무인자(`testpaths = tests`)·`.`·`tests`·`tests_isolation` 수집은 모두 정상 종료(rc 0)하고 `probe_outside` 노드가 0건입니다(`.` 은 `--ignore=probe_outside` 가 막음). `probe_outside` 를 직접 지정하면 그 conftest 첫 동작인 outside 가드가 EXIT 4 + `OHMYSLACK-OUTSIDE-GUARD-REFUSED` 로 끊습니다. `--preflight` 가 이 다섯 경우를 sandbox 안에서 확인하고, 첫 실패에서 즉시 멈춥니다(뒤 수집 0).

| 모드 | 명령(`integrations/hermes-plugin` 에서) | 기대 |
|---|---|---|
| 에이전트 점검 | `bash scripts/isolated-pytest.sh --preflight; echo EXIT=$?` | `tests_isolation` 통과 → 수집 4조합 rc 0·outside 0건 → 직접 지정 rc 4 + outside 표지 → `PREFLIGHT PASS`, `EXIT=0`. 실패 때 `PREFLIGHT FAIL: …`·`PREFLIGHT STOPPED`, `EXIT=1`(sandbox 오류·신호는 `EXIT=6`) |
| 가드 거부 점검 | `bash scripts/isolated-pytest.sh --probe-guard; echo EXIT=$?` | `OHMYSLACK-ISOLATION-GUARD-REFUSED: …`, `PROBE-GUARD PASS`, `EXIT=3` |
| 전체 실행(G3 뒤, 사람) | `bash scripts/isolated-pytest.sh --run --confirm=G3-CLEARED-BY-HUMAN` | TTY·난수 입력 뒤 `tests` 실행 |
| 전체 실행(레인·에이전트, 해시 대조) | `bash scripts/isolated-pytest.sh --run-attested [-q] [-x] [-k <식>]; echo EXIT=$?` | `scripts/pytest.sb`·`scripts/_iso_fs.sh` sha256 이 `scripts/G3-ATTESTATION` 과 같으면 `--run` 과 같은 경로(env·sandbox·가드)로 `tests` 실행. 없음·형식 오류·불일치면 아무것도 하지 않고 `re-attestation by human required`, `EXIT=5`. 그 밖 인자는 `EXIT=64` |
| 실서버 live(레인·`scripts/live-e2e.sh`, 해시 대조) | `scripts/live-e2e.sh` 가 live env 를 그 한 호출에만 붙여 `bash scripts/isolated-pytest.sh --run-live` 실행 | `--run-attested` 와 같은 해시 게이트(EXIT 5) → 인자 0개(`--confirm` 포함 무엇이든 `EXIT=64`) → live env 검증(위반 `EXIT=64`, 사유만) → 비밀은 `.isolation/` 0600 파일, sandbox 안 고정 인자 `-q -m live tests/test_live_e2e.py tests/test_live_standalone.py`. 거부 경로는 `--preflight` 자기시험(`tests_isolation/test_run_live.py`) |

### `--run-attested` 와 G3-ATTESTATION — 한계

- `scripts/G3-ATTESTATION` 은 사람 G3 확인((나)-0 `--prove-outside`·(나)-2 `--run`)을 통과한 프로필·정리 함수의 sha256 기록입니다(`main_commit`·`evidence`·`attested_at` 포함). **사람만 갱신합니다.** `pytest.sb`·`_iso_fs.sh` 를 바꾸는 변경은 사람이 (나)-0·(나)-2 를 다시 확인한 뒤 이 파일을 고칩니다.
- 해시 대조는 **우발 실행·무심사 프로필 변경 방지**입니다. 저장소 쓰기 권한이 있는 행위자의 의도적 우회(래퍼·이 파일 자체 수정)는 막지 못합니다.
- 해시는 두 파일만 덮습니다. 래퍼(`isolated-pytest.sh`)·가드(`tests/_isolation_guard.py`)·`tests/conftest.py` 변경은 감지하지 않습니다.
- 그래서 실효 프로필을 만드는 해시 밖 래퍼 부분 — 프로필 렌더 치환(`@HERMES_SRC@`·`@HERMES_SRC_RE@`·`@ISO@`·`@P@`·`;;@DENY_PORT_RULES@`), `base_env` 의 env 허용목록·`PYTHONPATH`, `DENY_PORTS`, `PY_HOME`·`PY_EXE`·`HERMES_SRC`(읽기·exec 경로), 실행 인자(`PYTEST_ARGS`·`--run-attested` 허용 인자) — 가 바뀌면 `profile_sha256`·`iso_fs_sha256` 이 그대로여도 사람 G3 재확인((나)-0·(나)-2)이 필요합니다. 두 해시만으로는 그 변경을 검출하지 못합니다. 이 규칙은 문서 약속이며 자동 검사는 없습니다.
- Issue #47 레인 B 의 `--run-live` 추가(새 모드·해시 게이트 적용 범위·live 전용 env 7개와 `*_FILE` 경로·고정 pytest 인자·`--preflight` 의 `run_live_selftest` 단계)는 이 규칙의 대상인 해시 밖 래퍼 변경입니다 — 사람 재확인 전에는 쓰지 않습니다.
- 대조는 `_iso_fs.sh` 를 source 하기 전, `.isolation/` 을 건드리기 전에 합니다. EXIT 5 경로는 `--preflight` 가 `.isolation/tmp` 안 복사본을 바꿔 자기시험하고 `tests_isolation/test_attestation.py` 가 결과를 단언합니다(작업 트리 파일은 바꾸지 않음).

### 사람 실행 (나) 0–5 — 에이전트는 실행하지 않습니다

(나)-0 은 `gateway` import·`~/.hermes` 열기를 포함하므로 관찰 동결(11-16) 종료 뒤 또는 영환님 명시 승인 뒤에 실행합니다.

| # | 명령 | 기대 출력 |
|---|---|---|
| 0 | `bash scripts/isolated-pytest.sh --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN; echo EXIT=$?` (사람 터미널, 화면의 4자리 입력) | `probe_outside/test_outside_probe.py` 6건 PASS: 홈·`/tmp` 카나리 쓰기 `PermissionError`, `~/.hermes/config.yaml`·`hermes-agent/.git/HEAD` 열기 `PermissionError`, `gateway` import 스모크 성공, 임의 포트 X listen 뒤 연결 `PermissionError`. `EXIT=0` |
| 1 | `ls -la ~/.ohmyslack-sbx-canary-* /tmp/ohmyslack-sbx-canary-* 2>&1` | `No such file or directory` 2줄 |
| 2 | `touch .isolation/marker` → `--run` 전체 실행 → `find ~/.hermes/hermes-agent -newer .isolation/marker -not -path '*/.git/*' -print \| head -20` | 0줄(게이트웨이가 쓰는 파일이 섞이면 경로를 붙여 사람이 판정) |
| 3 | `realpath .venv/bin/python` | `…/generation-1786174606-…/cpython-3.11.15-macos-aarch64-none/bin/python3.11` (래퍼가 이 실경로로 프로필을 렌더링) |
| 4 | `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true; echo EXIT=$?` (사람 터미널과 Orca 안 각각) | `EXIT=0`. 폐기된 `-n no-network` 는 이 OS 에서 `Killed: 9`(137)라 쓰지 않습니다 |
| 5 | 별도 명령 없음 — 0행의 임의 포트 X 결과 | X 연결이 sandbox 거부로 PASS. 8787·8788 은 연결하지 않고, 같은 목록에서 생성된 거부 줄 존재만 `grep -n 'localhost:87' .isolation/profile.sb` 로 확인 |

#### (나)-0 에서 import 가 막힐 때 — 진단 (사람 실행)

`ModuleNotFoundError`·`PermissionError` 로 0행이 실패하면 사람 터미널에서 거부 로그를 봅니다.

```
log show --last 5m --style compact --predicate 'sender == "Sandbox" AND eventMessage CONTAINS "deny"' | grep -i python | tail -30
```

거부된 경로가 `@HERMES_SRC@`(= `~/.hermes/hermes-agent`) 최상위 `*.py` 이면, 프로필 `scripts/pytest.sb` 에 `(allow file-read* (literal "<그 파일 경로>"))` 를 추가합니다. 단 Hermes 루트 바로 아래, 점으로 시작하지 않는 이름의 `*.py` 는 정규식 1줄(`^<이스케이프된 루트>/[^./][^/]*\.py$`)로 이미 허용되어 있습니다(설계 N-12 「한 줄씩」 이탈 — 사람 재실행 반복 회피. `.local_settings.py` 처럼 점으로 시작하는 `.py` 는 거부). `.py` 아닌 루트 파일(`.env`·`config.yaml`·`*.json`·확장자 없는 파일)은 계속 거부됩니다. 하위 폴더는 근거가 있는 패키지 15개 — `agent`·`cron`·`gateway`·`hermes_cli`·`tools`(설계 r4:267 `.pyc` 목록), `pm`((나)-2 `--run` 의 `pm/__init__.py` 114 errors), `hermes_platform`(2026-11-20 `--run-attested` 230 errors, `agent/file_safety.py` 의 새 import), `utils`·`persistence`·`session_rules`·`providers`·`plugins`·`acp_adapter`·`tui_gateway`·`hermes_agent`(2026-11-20 사람 `--run` 의 `utils` 거부 뒤, 사람 실행 import 스캔(Hermes `caafe538`)의 정적 import 폐포 — `dev/handoff/pr37-merge-main-20261120/hermes-import-scan.txt`. `tests`·`evals` 제외) — 만 폴더마다 `(allow file-read* (subpath "@HERMES_SRC@/<패키지>"))` 한 줄씩 허용합니다(설계 r4:267 「폴더 단위 subpath 한 줄씩」). 그 밖 폴더(`venv`·`node_modules`·`data`·`logs`·`cache`·`sessions` 등)와 점으로 시작하는 폴더·파일(`.git`·`.env`)은 거부입니다. 이 15개가 정상 import 에 필요한 패키지 전부라는 증거는 없습니다(needs_validation) — 거부 로그에 다른 패키지 폴더가 나오면 그 폴더 한 줄과 근거를 추가하고, 폴더 일괄 정규식으로 되돌리지 않습니다. 다음 거부가 점 폴더이거나 루트의 `.py` 아닌 파일이면 허용 여부는 사람이 판정합니다. 루트 디렉터리 자체의 목록 읽기(`literal "@HERMES_SRC@"`)는 이미 허용되어 있습니다 — FileFinder 의 `os.listdir` 용이며 하위 파일 내용은 열리지 않습니다.

추가 사람 확인: 인터프리터 base 의 `sitecustomize`·`.pth`(H-4). 프로필이 mach*·ipc*·iokit*·sysctl-write·user-preference* 를 다시 거부하므로 0행·`--run` 이 이 이름들에서 막히면 거부 로그로 필요한 이름만 한 줄씩 재허용합니다(N-22).
