"""실서버 E2E(-m live): /me → WS 구독 → owner 메시지 1건 → 어댑터 WS 수신 → 봇 답장 → 이력 GET 확인.

기본 실행에서는 빠진다(pytest.ini `-m "not live"` + `OHMYSLACK_LIVE_E2E=1` 필요). `scripts/live-e2e.sh`가 서버·봇·owner
세션을 준비하고 아래 env를 넘긴다. 토큰·쿠키 값은 출력하지 않는다.

- `OHMYSLACK_BOT_URL`: 봇 리스너 origin(예: http://127.0.0.1:PORT)
- `OHMYSLACK_BOT_TOKEN`: 봇 Bearer 토큰(omsb_…)
- `OHMYSLACK_LIVE_OWNER_SEND`: owner 메시지 1건을 게시하는 셸 명령. 테스트가 `OHMYSLACK_LIVE_DM_ID`·`OHMYSLACK_LIVE_BODY`를
  env로 넘긴다(명령 문자열에는 비밀 값을 직접 넣지 말고 env 이름으로 참조할 것 — 실패 메시지에 명령이 실린다).
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

# conftest의 autouse `_isolated_env`가 테스트 본문 전에 봇 env를 지우므로 import 시점에 읽는다.
LIVE = os.environ.get("OHMYSLACK_LIVE_E2E") == "1"
BOT_URL = os.environ.get("OHMYSLACK_BOT_URL", "")
BOT_TOKEN = os.environ.get("OHMYSLACK_BOT_TOKEN", "")
OWNER_SEND = os.environ.get("OHMYSLACK_LIVE_OWNER_SEND", "")
WAIT_SECONDS = 15.0

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not (LIVE and BOT_URL and BOT_TOKEN and OWNER_SEND),
                       reason="live E2E: OHMYSLACK_LIVE_E2E=1·OHMYSLACK_BOT_URL·OHMYSLACK_BOT_TOKEN·"
                              "OHMYSLACK_LIVE_OWNER_SEND 필요"),
]


async def _owner_send(dm_id: str, body: str) -> None:
    env = {**os.environ, "OHMYSLACK_LIVE_DM_ID": dm_id, "OHMYSLACK_LIVE_BODY": body}
    proc = await asyncio.create_subprocess_shell(OWNER_SEND, env=env, stdout=asyncio.subprocess.DEVNULL,
                                                 stderr=asyncio.subprocess.DEVNULL)
    code = await asyncio.wait_for(proc.wait(), timeout=WAIT_SECONDS)
    assert code == 0, f"OHMYSLACK_LIVE_OWNER_SEND exited with {code}"


async def _wait(cond, timeout: float = WAIT_SECONDS) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        assert loop.time() < end, "live E2E: condition not met in time"
        await asyncio.sleep(0.05)


async def test_live_owner_message_round_trip(tmp_path):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import OhmySlackAdapter
    from ohmyslack.client import BotClient, new_session

    async with new_session() as session:
        client = BotClient(BOT_URL, BOT_TOKEN, session)
        me = await client.get_me()
        assert me["owner_user_id"] and me["conversation_ids"]
        dm_id = str(me["conversation_ids"][0])

        cfg = PlatformConfig(enabled=True, token=BOT_TOKEN, extra={"url": BOT_URL})
        adapter = OhmySlackAdapter(cfg, cursor_path=tmp_path / "cursor.json")
        events: list = []
        catch_up_seen: list[int] = []  # catch-up 진입 시점의 수신 건수 — WS 경로 수신 증거

        async def _capture(event):
            events.append(event)

        adapter.handle_message = _capture
        original_catch_up = adapter._catch_up

        async def _tracking_catch_up(after: int) -> None:
            catch_up_seen.append(len(events))
            await original_catch_up(after)

        try:
            assert await adapter.connect() is True  # 첫 연결: snapshot 초기화 + WS 구독, 실행 없음
            assert events == []
            await asyncio.sleep(0.5)  # 구독 ACK 대기(서버 구독 등록 전 게시 방지)
            adapter._catch_up = _tracking_catch_up
            body = f"live-e2e {uuid.uuid4()}"
            await _owner_send(dm_id, body)
            await _wait(lambda: any(e.text == body for e in events))
            # WS `message.created`는 수신(ingest) 후에 catch-up을 부른다 — 첫 catch-up 시점에 이미 수신돼 있어야 한다.
            assert not catch_up_seen or catch_up_seen[0] >= 1, "owner message arrived via REST catch-up, not WS"
            event = events[-1]
            assert event.user_id == me["owner_user_id"]

            reply = f"live-e2e reply {uuid.uuid4()}"
            res = await adapter.send(dm_id, reply)
            assert res.success, res.error
            history = await client.request("GET", f"/conversations/{dm_id}/messages")
            bodies = [m.get("body") for m in history.get("messages") or ()]
            assert body in bodies and reply in bodies
        finally:
            await adapter.disconnect()
