# QA-FR-BOT-10 — 채널 멘션 봇 어댑터 pytest + 봇 채널 참여 격리 QA (DEV_DESIGN 6-6 FR-BOT-10, 5-4 형식)

> 기준: `docs/09-specs/BOT_CHANNEL_SPEC.md` §5-9(어댑터 pytest 케이스 1–8)·§3·§4, DEV_DESIGN `### 6-6.` FR-BOT-10 「수동」 열, README `integrations/hermes-plugin/README.md` 「개발·테스트」.
> 근거 수준: pytest·통합 테스트·격리 테스트 서버 curl·ego-browser 관찰은 **L1**(QA 직접 실행, 2026-11-10). 실제 Hermes 게이트웨이 + 운영 채널 멘션 왕복은 **실행하지 않음** — 아래 ③은 「Jarvis 판정 대기」.
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

## ① 어댑터 pytest 케이스 1–8

| 필드 | 값 |
|---|---|
| 실행자 | Claude(p1-l4-bot-channel-qa QA 레인, 구현자와 분리) |
| 일시(KST) | 2026-11-10 16:25–16:27 KST(1회) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Python 3.11(`~/.hermes/hermes-agent/venv/bin/python3.11` 기반 로컬 `.venv`, uv, `dev/active/p1-l4-bot-channel-qa/.venv`) / pytest·pytest-asyncio·aiohttp / 브라우저 해당 없음 |
| 접속 경로 | localhost — 테스트가 띄우는 가짜 aiohttp 봇 서버(`127.0.0.1` 임의 포트), 운영 서버·게이트웨이 미접속 |
| 절차 | ① `uv venv dev/active/p1-l4-bot-channel-qa/.venv --python ~/.hermes/hermes-agent/venv/bin/python3.11` ② `uv pip install --python <venv>/bin/python pytest pytest-asyncio aiohttp pyyaml ruamel.yaml` ③ `cd integrations/hermes-plugin` ④ `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/.hermes/hermes-agent <venv>/bin/python -m pytest -q -rA -p no:cacheprovider`(pytest.ini `addopts = -m "not live"`) |
| 기대 결과 | 전체 통과·실패 0. §5-9 케이스 1–8이 `tests/test_channel.py`·`test_inbound.py`·`test_outbound.py`에서 모두 통과 |
| 실제 결과 | `90 passed, 1 deselected`, EXIT 0(test_inbound 22 · test_outbound 20 · test_channel 18 · test_attachments 20 · test_contract_r33 10). deselected 1건 = `tests/test_live_e2e.py`(live 마커, **미실행**). 케이스별 결과는 아래 표 |
| 판정 | `PASS` — 어댑터 단위 계약(케이스 1–8)에 한함 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-l4-bot-channel-qa/evidence/hermes-pytest.txt` |

| 케이스 | §5-9 내용 | 테스트(`tests/test_channel.py` 등) | 결과 |
|---|---|---|---|
| 1 | owner 멘션 최상위 → `chat_type=channel`·새 세션, 답글 → 같은 세션 | `test_case1_channel_mention_top_level_new_session_reply_same_session`, `test_case1_dm_still_dm_chat_type_and_body_untouched` | PASS |
| 2 | 멘션 없는 owner 메시지 → 무시, backlog 0 | `test_case2_channel_owner_without_mention_ignored_and_not_counted` | PASS |
| 2b | (§10 Q5 변경 2026-11-13) 봇 스레드의 owner 비멘션 답글 → 같은 세션·본문 그대로. 비봇 스레드·비owner·다른 사용자만 멘션·수정본 → 무시, 재시작 후 루트 조회 통과, 조회 404/500 → 거부·재조회 억제 | `test_case2_bot_thread_owner_reply_without_mention_continues_same_session`, `test_thread_follow_*`(8건) — 2026-11-13 어댑터 pytest 114 passed | PASS(자동) |
| 3 | owner 아닌 사람의 멘션 → 무시 | `test_case3_channel_non_owner_mention_ignored` | PASS |
| 4 | `@봇 /approve` 답글 → 토큰 제거 후 승인 파싱 | `test_case4_channel_approve_reply_strips_leading_token`, `test_case4_strip_only_first_leading_token_with_word_boundary` | PASS |
| 5 | `membership.changed` joined/left·`not_found` | `test_case5_joined_subscribes_without_reconnect_then_left_ignores`, `test_case5_error_not_found_removes_conversation`, `test_case5_joined_unconfirmed_by_me_does_not_subscribe`, `test_case5_join_racing_catch_up_does_not_drop_first_mention` | PASS |
| 6 | 루트 없는 채널 송신 → 거부 | `test_case6_channel_send_without_root_is_refused`, `test_case6_standalone_refuses_channel_home` | PASS |
| 7 | 15분 지난 채널 멘션 → 실행 안 함, DM 안내 1회 | `test_case7_stale_channel_mention_notice_goes_to_dm_once` | PASS |
| 8 | DM 회귀(`test_inbound.py`·`test_outbound.py` 전체) | test_inbound 22/22, test_outbound 20/20 | PASS |

## ② 서버 봇 채널 참여(FR-BOT-08·09·11) 격리 환경 확인

| 필드 | 값 |
|---|---|
| 실행자 | Claude(p1-l4-bot-channel-qa QA 레인) |
| 일시(KST) | 2026-11-10 16:25–16:45 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Node 26.13.0 / ego-browser(Ego Lite, skill v2.2.0) 1680px 기본 + CDP 뷰포트 390·768·1280 |
| 접속 경로 | `http://127.0.0.1:<임의 포트>`(메인) + 봇 리스너 `127.0.0.1:<임의 포트>`(BOT_PORT), DB `ohmyslack_test` 안 실행별 스키마(종료 시 DROP). 운영 DB·`.env`·8787/8788 미접속 |
| 절차 | ① main 86f7d43 worktree `pnpm -r build` → 테스트 스키마 migrate·bootstrap-owner → 서버 기동 ② `bot-admin create`·`token issue`(토큰은 600 파일만) ③ 초대 생성·수락 API로 일반 멤버 ④ curl: 권한·봇 읽기 범위(`tools/curl-4-5.sh`) ⑤ ego-browser: owner 채널 「봇 추가」 표시 → 추가 → 멘션 후보 → 「봇 제거」 Dialog → 제거, DM·나간 채널·일반 멤버 표시 0, 390·768·1280 배치 ⑥ 통합 테스트 `bot-channel-{membership,scope,mention}`·`bot-thread`·`bot-scope` |
| 기대 결과 | BOT_CHANNEL_SPEC §3-5·§4-1·§4-2·§4-5, PRD FR-BOT-08·09·11 수용 기준 |
| 실제 결과 | 권한: 일반 멤버 POST/DELETE 403·DB 변화 0, 나간(비참여) 채널 404, DM 400, 사람 대상 404, 봇 토큰 메인 포트 401·봇 포트 경로 없음 404, 인증 없음 401(Origin 없으면 403 `origin_rejected`, Host 불일치 400 `host_not_allowed`), 재추가 200 멱등. 읽기 범위: 추가 전 메시지는 이력·snapshot·sync 0, 추가 후 메시지 보임, 추가 전 루트 답글 조회 404·답글 쓰기 404(저장 0), 추가 후 루트 답글 쓰기 201. UI: owner·채널·참여 중에만 「봇 추가: QA봇」, DM·나간 채널·일반 멤버 0; 추가 → 멤버 2→3, `@` 후보에 「QA봇 봇」; Dialog 문구 G-44~46 일치, DELETE 204, 이후 봇 토큰 이력·쓰기 404. 통합 5파일 11/11 통과. **결함 1건(Low)**: 390px에서 「봇 제거: QA / 봇」 2줄 줄바꿈 + 채널명 「#qa…」 잘림 |
| 판정 | `PASS`(조건부 — 390px 표시 결함 Low 1건, 기능 영향 없음) |
| 증거 경로 | (`dev/` gitignore — 로컬 보관) `dev/active/p1-l4-bot-channel-qa/evidence/` — `curl-4-5.txt`, `3-ui-bot-token.txt`, `server-int-tests.txt`, `1-*.png/.aria.txt`, `2-*.png/.aria.txt`, `3-*.png/.aria.txt`, `6-width-{390,768,1280}.png` |

## ③ 실기 채널 멘션 왕복(운영 게이트웨이 + owner 계정 채널 멘션)

| 필드 | 값 |
|---|---|
| 실행자 | 영환님(owner 계정 조작) / 판정 Jarvis(운영 DB·게이트웨이 로그 읽기 전용) |
| 일시(KST) | 2026-11-10 16:44:18–16:44:35 |
| 기기·OS·브라우저(버전) | 영환님 기기(기록 없음 — 미확인) |
| 접속 경로 | 운영 서버 main `86f7d43`(prod-main), Hermes 게이트웨이 PID 66171(16:22:13 시작, 새 어댑터) |
| 절차 | 운영 채널 `샘픙방`(멤버 owner 1명)에 웹에서 봇 추가 → owner가 `@Jarvis 채널 연결 테스트` 최상위 멘션 → 멘션 없는 최상위 글 1건 |
| 기대 결과 | BOT_CHANNEL_SPEC §3-1·§3-2: 멘션 글에만 봇 스레드 답글, 비멘션 글 무응답, 채널 최상위 봇 글 0 |
| 실제 결과 | ① 봇 멤버 행 `joined_seq=3`, `left_at` 없음(웹 추가 성공). ② seq 4 owner 멘션 글 `message_mentions`에 봇 1건. ③ 게이트웨이 `inbound … chat=<채널> msg='채널 연결 테스트'`(멘션 토큰 제거됨), 세션 키 `agent:jarvis:ohmyslack:channel:<채널>:<seq4 id>` → 5.4초 뒤 `response ready`. ④ seq 5 봇 글은 `thread_root_id = seq 4`(스레드 답글), 채널 최상위 봇 글 0. ⑤ seq 6 비멘션 글(멘션 0)은 게이트웨이 inbound 기록 0·봇 응답 0. |
| 미실행 | 같은 스레드 후속 답글로 세션 연속 확인, 봇 제거 후 멘션 무응답(운영) — 실행하지 않음. 제거 후 차단은 격리 QA ②에서 PASS(404). |
| 판정 | `PASS`(실행한 범위 ①–⑤에 한함) |
| 증거 경로 | 운영 DB `ohmyslack` 읽기 전용 조회(conversation_members·messages·message_mentions, 채널 `6d9fb0df-…`), `~/.hermes/profiles/jarvis/logs/gateway.log` 16:44:18·16:44:23 줄 |
