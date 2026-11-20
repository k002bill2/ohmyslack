"""실서버 E2E(-m live): /me → WS 구독 → owner 메시지 1건 → 어댑터 WS 수신 → 봇 답장 → 이력 GET 확인.

기본 실행에서는 빠진다(pytest.ini `-m "not live"` + `OHMYSLACK_LIVE_E2E=1` 필요). `scripts/live-e2e.sh`가 서버·봇·owner
세션을 준비하고 격리 래퍼 `scripts/isolated-pytest.sh --run-live`(sandbox 안)로 이 파일을 돌린다. 토큰·쿠키 값은 출력하지 않는다.

- `OHMYSLACK_BOT_URL`: 봇 리스너 origin(예: http://127.0.0.1:PORT)
- `OHMYSLACK_BOT_TOKEN_FILE`(또는 `OHMYSLACK_BOT_TOKEN`): 봇 Bearer 토큰(omsb_…). 래퍼는 값을 env 에 싣지 않고 0600 파일 경로만 넘긴다.
- `OHMYSLACK_LIVE_MAIN_URL`·`OHMYSLACK_LIVE_ORIGIN`: 사람 리스너 origin·Origin 헤더 값.
- `OHMYSLACK_LIVE_COOKIE_FILE`·`OHMYSLACK_LIVE_CSRF_FILE`(또는 `OHMYSLACK_LIVE_COOKIE`·`OHMYSLACK_LIVE_CSRF`): owner 세션 쿠키
  (`__Host-oms_session=…` 쌍)·CSRF 토큰.
owner 메시지 게시는 예전 `OHMYSLACK_LIVE_OWNER_SEND`(셸 subprocess → `scripts/live_owner_send.py`) 대신 테스트 프로세스 안
aiohttp 요청으로 한다 — sandbox 프로필이 process-fork 를 막는다(`scripts/pytest.sb` process-fork 거부). 요청 모양은 그 스크립트와 같다.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest


def _secret(name: str) -> str:
    """`<name>` env 값, 없으면 `<name>_FILE` 이 가리키는 파일 내용(끝 줄바꿈 제거). 둘 다 없으면 ""."""
    value = os.environ.get(name, "")
    path = os.environ.get(f"{name}_FILE", "")
    if value or not path:
        return value
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().rstrip("\r\n")
    except OSError:
        return ""


# conftest의 autouse `_isolated_env`가 테스트 본문 전에 봇 env를 지우므로 import 시점에 읽는다.
LIVE = os.environ.get("OHMYSLACK_LIVE_E2E") == "1"
BOT_URL = os.environ.get("OHMYSLACK_BOT_URL", "")
BOT_TOKEN = _secret("OHMYSLACK_BOT_TOKEN")
MAIN_URL = os.environ.get("OHMYSLACK_LIVE_MAIN_URL", "")
ORIGIN = os.environ.get("OHMYSLACK_LIVE_ORIGIN", "")
COOKIE = _secret("OHMYSLACK_LIVE_COOKIE")
CSRF = _secret("OHMYSLACK_LIVE_CSRF")
WAIT_SECONDS = 15.0

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not (LIVE and BOT_URL and BOT_TOKEN and MAIN_URL and ORIGIN and COOKIE and CSRF),
                       reason="live E2E: OHMYSLACK_LIVE_E2E=1·OHMYSLACK_BOT_URL·OHMYSLACK_BOT_TOKEN(_FILE)·"
                              "OHMYSLACK_LIVE_MAIN_URL·OHMYSLACK_LIVE_ORIGIN·OHMYSLACK_LIVE_COOKIE(_FILE)·"
                              "OHMYSLACK_LIVE_CSRF(_FILE) 필요"),
]


async def _owner_send(dm_id: str, body: str) -> None:
    """owner 세션으로 DM에 메시지 1건 게시 — `scripts/live_owner_send.py`와 같은 요청(사람 리스너
    `POST /api/conversations/:id/messages`, 헤더 content-type·origin·cookie·x-csrf-token, 본문 client_message_id·body).
    성공 = 200/201(그 스크립트의 exit 0 조건). 실패 메시지에는 상태 코드만 싣는다(비밀 값 없음)."""
    import aiohttp

    url = f"{MAIN_URL}/api/conversations/{dm_id}/messages"
    data = json.dumps({"client_message_id": str(uuid.uuid4()), "body": body}).encode()
    headers = {"content-type": "application/json", "origin": ORIGIN, "cookie": COOKIE, "x-csrf-token": CSRF}
    timeout = aiohttp.ClientTimeout(total=WAIT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, data=data, headers=headers, allow_redirects=False) as resp:
            status = resp.status
    assert status in (200, 201), f"owner send failed: HTTP {status}"


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
