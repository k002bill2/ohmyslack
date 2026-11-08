# QA-FR-BOT-04 — 어댑터 스레드=세션 매핑 pytest (DEV_DESIGN 6-2 FR-BOT-04, 5-4 형식)

> 기준: DEV_DESIGN 6-2 FR-BOT-04 「수동」 열(`어댑터 pytest: 최상위=새 세션·답글=같은 세션 매핑 결과 첨부`), W-20 완료 기준, §5-1 「어댑터 pytest(R3.3)」(pnpm verify 밖), README `integrations/hermes-plugin/README.md` 「개발·테스트」 실행법.
> 근거 수준: pytest 실행·결과는 **L1**(QA 직접 실행). 실제 Hermes 게이트웨이에서의 세션 연속성은 이 문서 범위 밖이며 L1 증거 없음(아래 범위 한계).
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-24 QA 레인) |
| 일시(KST) | 2026-11-09 02:36(전체 1회) · 02:40(전체 재실행 + 지정 3건 단독 실행) KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Python 3.11.15(`~/.hermes/hermes-agent/venv/bin/python3.11` 기반 로컬 `.venv`, uv) / pytest·pytest-asyncio·aiohttp 3.14.5 / 브라우저 해당 없음 |
| 접속 경로 | localhost — 테스트가 띄우는 가짜 aiohttp 봇 서버(`127.0.0.1` 임의 포트), `HERMES_HOME`은 tmp 격리. 운영 서버·게이트웨이 미접속 |
| 절차 | ① `cd integrations/hermes-plugin` ② `uv venv .venv --python ~/.hermes/hermes-agent/venv/bin/python3.11` ③ `uv pip install --python .venv/bin/python pytest pytest-asyncio aiohttp pyyaml ruamel.yaml` ④ `PYTHONPATH=~/.hermes/hermes-agent .venv/bin/python -m pytest -q -rA`(pytest.ini `addopts = -m "not live"`) ⑤ 지정 테스트 `tests/test_inbound.py::test_top_level_new_session_reply_same_session` 단독 실행 |
| 기대 결과 | 전체 통과·실패 0. 지정 테스트: 최상위 메시지 → `thread_id = message.id`(새 세션), 그 답글 → `thread_id = thread_root_id`(같은 세션), 다른 최상위 → 다른 세션, 모두 같은 `chat_id`(DM) |
| 실제 결과 | ④ `52 passed, 1 deselected`, EXIT 0(두 번 실행 모두). ⑤ `PASSED tests/test_inbound.py::test_top_level_new_session_reply_same_session` — 단언 `threads == [root.id, root.id, other_root.id]`, `chat_id == DM_ID`. 함께 통과한 관련 테스트: `test_reply_to_a_reply_is_corrected_to_root`(답글의 답글 → 루트로 보정), `test_send_long_message_posts_chunks_in_same_thread`, `test_send_reply_uses_thread_root_and_retries_429_idempotently`. **범위 한계:** ① deselected 1건은 `tests/test_live_e2e.py::test_live_owner_message_round_trip`(live 마커, 실제 서버 대상)이며 **이번에 실행하지 않음** ② 이 pytest는 어댑터가 Hermes에 넘기는 `thread_id` 매핑을 증명할 뿐, Hermes 런타임이 그 thread_id로 세션을 실제로 이어 붙이는지(특히 cron 브리핑에 단 답글)는 증명하지 않음 — README 「Hermes 확인 항목」 4번이 「런타임은 미확인」으로 기록 |
| 판정 | `PASS` — 6-2 수동 열 요구(어댑터 pytest의 최상위=새 세션·답글=같은 세션 매핑 결과 첨부)에 한함. Hermes 런타임 세션 연속성은 `QA-HERMES-CUTOVER.md` ④에서 별도 관찰 |
| 증거 경로 | (`dev/`는 gitignore — 로컬 보관) `dev/active/p1-w24-qa-cutover/evidence/bot-04-06-pytest.txt`(전체 PASSED 목록·EXIT·deselected 대상) · 테스트 소스 `integrations/hermes-plugin/tests/test_inbound.py:184-196` · 자동 증거: `apps/server/test/bots/bot-thread.int.test.ts`(지정) |
