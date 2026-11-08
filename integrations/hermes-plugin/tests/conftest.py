"""가짜 ohmyslack 봇 리스너(aiohttp) + 어댑터 fixture. 서버 계약: TRD R3.3 §5-2, shared sync/realtime zod."""

from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pytest
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FIXTURE_BEARER = "omsb_fixture-1"  # 가짜 서버 전용 fixture 값(실제 토큰 아님)
TOKEN = FIXTURE_BEARER
BOT_ID = str(uuid.UUID(int=1))
OWNER_ID = str(uuid.UUID(int=2))
OTHER_ID = str(uuid.UUID(int=3))
DM_ID = str(uuid.UUID(int=100))


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path, monkeypatch):
    # Hermes 홈을 tmp로 격리(실제 ~/.hermes 읽기·쓰기 방지), 플러그인 env 비움.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    for name in ("OHMYSLACK_BOT_TOKEN", "OHMYSLACK_BOT_URL", "OHMYSLACK_BOT_PORT", "OHMYSLACK_HOME_CHANNEL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="session", autouse=True)
def _registered_platform():
    """`Platform("ohmyslack")`는 레지스트리 등록 후에만 해석된다(gateway/config.py `_missing_`)."""
    from gateway.platform_registry import PlatformEntry, platform_registry
    from ohmyslack import platform_kwargs
    platform_registry.register(PlatformEntry(**platform_kwargs(), source="plugin"))
    yield


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def make_message(*, author: str = OWNER_ID, body: str = "hello", conv: str = DM_ID,
                 thread_root_id: Optional[str] = None, age: float = 0.0, mid: Optional[str] = None) -> dict:
    import time
    return {
        "id": mid or str(uuid.uuid4()), "conversation_id": conv, "seq": 0, "author_id": author,
        "author_kind": "bot" if author == BOT_ID else "human", "client_message_id": str(uuid.uuid4()),
        "thread_root_id": thread_root_id, "body": body, "created_at": iso(time.time() - age),
        "edited_at": None, "deleted_at": None, "mention_user_ids": [], "root_reply_count": None,
        "attachments": [],
    }


class FakeBotServer:
    def __init__(self) -> None:
        self.changes: list[tuple[int, str, dict]] = []
        self.next_change = 10
        self.snapshot_messages: list[dict] = []
        self.snapshot_pages: list[list[dict]] = []
        self.me_status = 200
        self.sync_expired_below: Optional[int] = None
        self.ws_fail = 0
        self.ws_status = 503
        self.post_429 = 0
        self.page_size = 2
        self.requests: list[tuple[str, str, dict]] = []
        self.posts: list[dict] = []
        self.patches: list[tuple[str, dict]] = []
        self.sockets: list[web.WebSocketResponse] = []
        self.ws_connects = 0
        self.subscribes = 0
        self.base = ""
        self._runner: Optional[web.AppRunner] = None

    # ---- state helpers ----
    def add(self, message: dict, conv: str = DM_ID) -> int:
        self.next_change += 1
        self.changes.append((self.next_change, conv, message))
        return self.next_change

    async def push_live(self, message: dict, conv: str = DM_ID) -> None:
        cid = self.add(message, conv)
        for ws in list(self.sockets):
            if not ws.closed:
                await ws.send_json({"type": "message.created", "conversation_id": conv, "change_id": cid,
                                    "message": message})

    async def drop_all(self) -> None:
        for ws in list(self.sockets):
            await ws.close()
        self.sockets.clear()

    # ---- handlers ----
    def _log(self, request: web.Request) -> None:
        self.requests.append((request.method, request.path, dict(request.headers)))

    async def me(self, request):
        self._log(request)
        if self.me_status != 200:
            return web.json_response({"error": "unauthorized"}, status=self.me_status)
        return web.json_response({"id": BOT_ID, "owner_user_id": OWNER_ID, "conversation_ids": [DM_ID]})

    async def sync(self, request):
        self._log(request)
        after = int(request.query["after"])
        if self.sync_expired_below is not None and after < self.sync_expired_below:
            return web.json_response({"error": "cursor_expired"}, status=410)
        latest = self.changes[-1][0] if self.changes else self.next_change
        through = int(request.query.get("through", latest))
        window = [c for c in self.changes if after < c[0] <= through]
        page, more = window[: self.page_size], len(window) > self.page_size
        nxt = page[-1][0] if (page and more) else through
        return web.json_response({
            "changes": [{"change_id": c, "conversation_id": conv, "message": m} for c, conv, m in page],
            "through_cursor": through, "scanned_through": nxt, "has_more": more, "next_cursor": nxt})

    async def snapshot(self, request):
        self._log(request)
        # snapshot_pages가 있으면 before_seq(=페이지 번호)로 과거 페이지를 내준다.
        pages = self.snapshot_pages or [self.snapshot_messages]
        idx = int(request.query.get("before_seq", 0))
        more = idx + 1 < len(pages)
        return web.json_response({"snapshot_cursor": self.next_change, "conversation_id": request.query["conversation_id"],
                                  "messages": pages[idx], "has_more": more, "next_before_seq": idx + 1 if more else None})

    async def post(self, request):
        self._log(request)
        payload = await request.json()
        if self.post_429 > 0:
            self.post_429 -= 1
            self.posts.append({**payload, "_status": 429})
            return web.json_response({"error": "rate_limited"}, status=429, headers={"Retry-After": "1"})
        self.posts.append({**payload, "_status": 200, "conversation_id": request.match_info["cid"]})
        msg = make_message(author=BOT_ID, body=payload["body"], thread_root_id=payload.get("thread_root_id"))
        msg["client_message_id"] = payload["client_message_id"]
        return web.json_response({"message": msg, "seq": 1, "change_id": self.add(msg), "mention_user_ids": []})

    async def patch(self, request):
        self._log(request)
        self.patches.append((request.match_info["mid"], await request.json()))
        msg = make_message(author=BOT_ID, mid=request.match_info["mid"])
        return web.json_response({"message": msg, "seq": 1, "change_id": self.add(msg), "mention_user_ids": []})

    async def ws(self, request):
        self._log(request)
        self.ws_connects += 1
        if self.me_status != 200:
            return web.Response(status=self.me_status)
        if self.ws_fail > 0:
            self.ws_fail -= 1
            return web.Response(status=self.ws_status)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.sockets.append(ws)
        async for msg in ws:
            frame = msg.json()
            if frame.get("type") == "conversation.subscribe":
                self.subscribes += 1
                after = frame["after_cursor"]
                for cid, conv, m in [c for c in self.changes if c[0] > after and c[1] == frame["conversation_id"]]:
                    await ws.send_json({"type": "message.created", "conversation_id": conv, "change_id": cid, "message": m})
                await ws.send_json({"type": "conversation.subscribed", "conversation_id": frame["conversation_id"],
                                    "through_cursor": self.next_change})
        return ws

    async def start(self) -> None:
        app = web.Application()
        p = "/api/bot/v1"
        app.router.add_get(f"{p}/me", self.me)
        app.router.add_get(f"{p}/sync", self.sync)
        app.router.add_get(f"{p}/sync/snapshot", self.snapshot)
        app.router.add_post(f"{p}/conversations/{{cid}}/messages", self.post)
        app.router.add_patch(f"{p}/messages/{{mid}}", self.patch)
        app.router.add_get(f"{p}/ws", self.ws)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        await self.drop_all()
        if self._runner:
            await self._runner.cleanup()


class FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.calls.append(delay)
        await asyncio.sleep(0)


@pytest.fixture
async def server():
    srv = FakeBotServer()
    await srv.start()
    yield srv
    await srv.stop()


@pytest.fixture
def fake_sleep():
    return FakeSleep()


@pytest.fixture
async def make_adapter(server, fake_sleep, tmp_path):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import OhmySlackAdapter
    created: list[Any] = []

    def _make(url: Optional[str] = None, token: str = TOKEN, cursor_path: Optional[Path] = None):
        cfg = PlatformConfig(enabled=True, token=token, extra={"url": url or server.base})
        adapter = OhmySlackAdapter(cfg, sleep=fake_sleep, rand=lambda: 0.0,
                                   cursor_path=cursor_path or tmp_path / "cursor.json")
        events: list[Any] = []

        async def _capture(event):
            events.append(event)

        adapter.handle_message = _capture
        adapter.events = events
        created.append(adapter)
        return adapter

    yield _make
    for a in created:
        await a.disconnect()


async def wait_for(cond, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)
