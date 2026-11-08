# ohmyslack Hermes 플랫폼 플러그인 (W-20)

Hermes 게이트웨이가 ohmyslack **봇 리스너**(`127.0.0.1:<BOT_PORT>/api/bot/v1`)에 붙어서 owner의 Jarvis DM 지시를 Hermes 세션으로 넘기고, 응답을 같은 스레드에 게시하는 플러그인입니다.
정본: ADR-001 §3, TRD R3.3 §5-2, DEV_DESIGN W-20.

## 배포 절차 (영환님)

1. 서버에서 봇 계정과 토큰을 발급합니다. 발급 도구는 `apps/server/bin/bot-admin.ts`이고, 토큰은 `omsb_…` 형식이며 발급할 때 한 번만 출력됩니다.
2. 플러그인을 설치합니다. 다음 둘 중 하나를 고릅니다.
   - 복사: `cp -R integrations/hermes-plugin/ohmyslack ~/.hermes/plugins/ohmyslack`
   - 링크: `ln -s "$PWD/integrations/hermes-plugin/ohmyslack" ~/.hermes/plugins/ohmyslack`
3. Hermes `.env`에 아래 env 값을 넣습니다. 이 저장소에는 값을 남기지 않습니다.
4. `hermes plugins enable ohmyslack`을 실행합니다. 이 명령은 config.yaml의 `plugins.enabled`에 이름을 추가합니다. bundled가 아닌 플러그인이라 capability 동의 절차가 한 번 나옵니다.
5. 게이트웨이를 재시작합니다(`hermes gateway restart` 또는 평소 쓰는 방법). 재시작 후 `hermes gateway status`에 `ohmyslack`이 connected로 표시되는지 확인합니다.

## env

| 이름 | 필수 | 설명 |
|---|---|---|
| `OHMYSLACK_BOT_TOKEN` | 예 | 봇 토큰. Hermes 비밀 저장 규칙(`get_scoped_secret`)으로만 읽고, 로그에는 남기지 않습니다 |
| `OHMYSLACK_BOT_URL` | 둘 중 하나 | 예: `http://127.0.0.1:<BOT_PORT>`. **루프백(`127.0.0.1`·`localhost`) + http + 포트**만 허용하며, 그 외 값이면 연결을 거부합니다(fatal `config_invalid`) |
| `OHMYSLACK_BOT_PORT` | 둘 중 하나 | URL이 없을 때 `http://127.0.0.1:<port>`로 씁니다 |
| `OHMYSLACK_HOME_CHANNEL` | 권장 | cron `deliver=ohmyslack`의 대상인 Jarvis DM conversation id입니다 |
| `OHMYSLACK_ALLOWED_USERS` | 권장 | owner user id입니다. Hermes 인가 계층에도 같은 owner를 넣습니다. 어댑터의 author_id 필터와 함께 이중 방어가 됩니다 |

커서 파일은 `~/.hermes/ohmyslack/cursor.json`(Hermes 홈 하위)에 저장합니다. 담는 값은 숫자 `change_id`, 저장 시각, 최근 처리한 message id뿐이고 본문과 토큰은 넣지 않습니다.

## 동작 요약

- **연결**
  - 순서: `GET /me` → cursor가 있으면 `GET /sync?after=` 페이지 catch-up → WS `/api/bot/v1/ws` → 참여 대화마다 `conversation.subscribe{after_cursor}`
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
- **아웃바운드**
  - `POST /conversations/{id}/messages`로 게시합니다. 답글이면 루트로 보정한 `thread_root_id`를 붙입니다
  - `client_message_id`를 고정해 멱등 재시도합니다. 429면 `Retry-After`(최대 60초)를 따르고, 5xx와 연결 오류도 재시도합니다
  - 4,000 code point를 넘으면 나눠 보냅니다(base `truncate_message`, 코드펜스 보존)
  - `edit_message`는 PATCH로 처리합니다. 스트리밍은 Hermes 설정을 따르며 기본은 꺼짐입니다
  - 음성·문서·이미지 파일·영상은 텍스트 대체 안내와 경고 로그로 처리합니다. 로그에 경로와 본문은 남기지 않습니다. 첨부 지원은 W-21 범위입니다
- **standalone sender**: 게이트웨이 밖에서 도는 cron이 같은 HTTP 클라이언트로 홈 채널에 **최상위** 메시지를 보냅니다

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
PYTHONPATH=~/.hermes/hermes-agent .venv/bin/python -m pytest -q
```

- 테스트는 가짜 aiohttp 봇 서버를 상대로 돌고, `HERMES_HOME`을 tmp로 격리합니다. 실제 서버나 게이트웨이에는 연결하지 않습니다.
- Hermes 본체는 `PYTHONPATH`로 읽기만 하며, 설치하거나 복사하지 않습니다.
