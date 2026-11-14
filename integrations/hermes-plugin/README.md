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
| `OHMYSLACK_HOME_CHANNEL` | 권장 | cron `deliver=ohmyslack`의 대상인 Jarvis DM conversation id입니다. **DM만** 됩니다 — 채널 id면 standalone 전송을 거부합니다 |
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
  - 송신은 **스레드 답글로만** 합니다. 루트를 모르는 채널 송신(첨부 포함)은 보내지 않고 로그만 남깁니다
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
  - 첨부(ADR-002 1a): `media_files`의 mp3·png·jpeg·webp는 라이브 경로와 같은 판정·상한(파일당 10 MiB, 메시지당 4개)으로 업로드해 텍스트의 첫 청크에 결속합니다(본문이 비면 첫 파일명). 모든 첨부가 결속되면 `media_delivered: True`를 함께 돌려줍니다
  - 지원 밖 형식(문서·영상 등)·없는 파일·상한 초과·업로드 실패·4개 초과(지원 형식 앞 4개만 시도)·시간 예산 초과는 업로드하지 않고 파일마다 `warnings`에 `"<파일명>: <사유>"` 한 줄(`unsupported_type`·`not_found`·`too_large`·`rejected`·`upload_failed`·`too_many`·`budget_exceeded`)을 싣습니다. 전송 전체(`/me`·파일 읽기·업로드·텍스트 게시와 재시도)는 시작부터 50초(`STANDALONE_TOTAL_DEADLINE_S`, Hermes 기본 상한 60초 − 여유 10초) 안에서만 하고, 업로드는 35초(`STANDALONE_UPLOAD_BUDGET_S`)와 "남은 시간 − 텍스트 몫 10초" 중 작은 값만 씁니다. 남은 시간보다 긴 재시도 대기(429 `Retry-After` 등)는 기다리지 않고, 텍스트를 deadline 안에 못 보내면 `deadline_exceeded` 오류(모인 첨부 사유 포함)로 끝냅니다. 텍스트는 그대로 보내고 `success`는 텍스트 전송 결과를 따릅니다(텍스트 실패는 `send_error`). Hermes cron은 `warnings`를 전달 오류로 올립니다
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

거부된 경로가 `@HERMES_SRC@`(= `~/.hermes/hermes-agent`) 최상위 `*.py` 이면, 프로필 `scripts/pytest.sb` 에 `(allow file-read* (literal "<그 파일 경로>"))` 를 추가합니다. 단 Hermes 루트 바로 아래 `*.py` 는 정규식 1줄(`^<이스케이프된 루트>/[^/]+\.py$`)로 이미 허용되어 있습니다(설계 N-12 「한 줄씩」 이탈 — 사람 재실행 반복 회피). `.py` 아닌 루트 파일(`.env`·`config.yaml`·`*.json`)은 계속 거부됩니다. 패키지형 최상위 폴더(이름이 소문자·숫자·`_` 만인 폴더 — `agent`·`gateway`·`pm`·`tools` 등)는 폴더 자체와 그 아래 전부를 정규식 1줄(`^<이스케이프된 루트>/[a-z_][a-z0-9_]*(/.*)?$`)로 일괄 허용합니다(설계 N-12 추가 이탈 — (나)-2 `--run` 의 `pm/__init__.py` 114 errors 대응. Hermes 코드는 비밀이 아니고 비밀은 `~/.hermes` 설정·프로필·`.env` 에 있으며 그쪽은 계속 거부). 점으로 시작하는 폴더·파일(`.git`·`.env`)과 대문자 시작 루트 파일도 거부 유지입니다. 다음 거부가 점 폴더이거나 루트의 `.py` 아닌 파일이면 허용 여부는 사람이 판정합니다. 루트 디렉터리 자체의 목록 읽기(`literal "@HERMES_SRC@"`)는 이미 허용되어 있습니다 — FileFinder 의 `os.listdir` 용이며 하위 파일 내용은 열리지 않습니다.

추가 사람 확인: 인터프리터 base 의 `sitecustomize`·`.pth`(H-4). 프로필이 mach*·ipc*·iokit*·sysctl-write·user-preference* 를 다시 거부하므로 0행·`--run` 이 이 이름들에서 막히면 거부 로그로 필요한 이름만 한 줄씩 재허용합니다(N-22).
