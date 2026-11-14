"""가짜 ohmyslack 봇 리스너(aiohttp) + 어댑터 fixture. 서버 계약: TRD R3.3 §5-2, shared sync/realtime zod."""

from __future__ import annotations

# 격리 가드 — Hermes 관련 어떤 import·session fixture보다 먼저(설계 r4 §Q5 ★구성 4). 어긋나면 EXIT 3.
from _isolation_guard import enforce as _enforce_isolation  # noqa: E402

_enforce_isolation()

import sys as _sys  # noqa: E402
import types as _types  # noqa: E402

# probe2형 의존성 준비·재실행 방지 스텁 + 바이트코드 쓰기 끔(가드 뒤).
_sys.modules.setdefault("hermes_bootstrap", _types.ModuleType("hermes_bootstrap"))
_sys.dont_write_bytecode = True

import asyncio
import sys
import threading
import types
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pytest
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Hermes 진입 부트스트랩(`gateway.run` 등이 import)은 의존성 준비·프로세스 재실행(execv)을 한다 — 테스트 프로세스에서는
# 절대 돌지 않게 빈 모듈로 막는다(Hermes 본체는 수정하지 않는다).
sys.modules.setdefault("hermes_bootstrap", types.ModuleType("hermes_bootstrap"))
# Hermes 체크아웃은 읽기 전용: import한 Hermes 모듈의 .pyc를 그 안 `__pycache__`에 쓰지 않는다.
sys.dont_write_bytecode = True

FIXTURE_BEARER = "omsb_fixture-1"  # 가짜 서버 전용 fixture 값(실제 토큰 아님)
TOKEN = FIXTURE_BEARER
BOT_ID = str(uuid.UUID(int=1))
OWNER_ID = str(uuid.UUID(int=2))
OTHER_ID = str(uuid.UUID(int=3))
DM_ID = str(uuid.UUID(int=100))
CHANNEL_ID = str(uuid.UUID(int=200))
BOT_NAME = "Jarvis"


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
                 thread_root_id: Optional[str] = None, age: float = 0.0, mid: Optional[str] = None,
                 mentions: Optional[list[str]] = None) -> dict:
    import time
    return {
        "id": mid or str(uuid.uuid4()), "conversation_id": conv, "seq": 0, "author_id": author,
        "author_kind": "bot" if author == BOT_ID else "human", "client_message_id": str(uuid.uuid4()),
        "thread_root_id": thread_root_id, "body": body, "created_at": iso(time.time() - age),
        "edited_at": None, "deleted_at": None, "mention_user_ids": list(mentions or []), "root_reply_count": None,
        "attachments": [],
    }


class FakeBotServer:
    def __init__(self) -> None:
        self.changes: list[tuple[int, str, dict]] = []
        self.ops: dict[int, str] = {}  # change_id → sync `op`(create|edit|delete). 없으면 op 미포함(구 서버)
        self.next_change = 10
        self.snapshot_messages: list[dict] = []
        self.snapshot_pages: list[list[dict]] = []
        self.me_status = 200
        self.sync_expired_below: Optional[int] = None
        self.sync_403 = 0  # 다음 N회 /sync를 403으로(권한 거부 — 인증 실패 아님)
        self.post_status: list[int] = []  # 다음 게시 응답 상태를 순서대로 강제(예: [403])
        self.post_retry_after = "1"  # post_status로 강제한 429 응답의 Retry-After 값
        self.ws_fail = 0
        self.ws_status = 503
        self.post_429 = 0
        self.ok_posts_before_429: Optional[int] = None  # 성공 게시 N건 이후로는 계속 429
        self.page_size = 2
        self.requests: list[tuple[str, str, dict]] = []
        self.posts: list[dict] = []
        self.patches: list[tuple[str, dict]] = []
        self.sockets: list[web.WebSocketResponse] = []
        self.ws_connects = 0
        self.subscribes = 0
        self.subscribed: list[tuple[str, int]] = []  # (conversation_id, after_cursor) 구독 요청 순서대로
        self.conversations: Optional[list[dict]] = [{"id": DM_ID, "kind": "dm"}]  # /me.conversations(BOT_CHANNEL_SPEC §4-4)
        self.display_name = BOT_NAME
        self.uploads: list[dict] = []  # 업로드 요청 기록(content_type·conversation_id·size·status)
        self.upload_status: list[int] = []  # 다음 업로드 응답 상태를 순서대로 강제(예: [429], [413])
        self.upload_retry_after = "1"  # 업로드 429 응답의 Retry-After 값
        self.upload_delay = 0.0  # 업로드 응답 전 실제 대기(초) — 업로드가 걸린 상황 재현용
        self.blobs: dict[str, tuple[str, bytes]] = {}  # 다운로드용 첨부 id → (mime, bytes)
        self.downloads: list[str] = []
        self.replies_status: Optional[int] = None  # 강제 응답 상태(예: 404·500). None이면 changes에서 루트를 찾는다
        self.replies_calls: list[str] = []  # GET messages/{root_id}/replies 요청 루트 id 순서대로
        self.base = ""
        self._runner: Optional[web.AppRunner] = None

    # ---- state helpers ----
    def add(self, message: dict, conv: str = DM_ID, op: Optional[str] = None) -> int:
        self.next_change += 1
        self.changes.append((self.next_change, conv, message))
        if op is not None:
            self.ops[self.next_change] = op
        return self.next_change

    async def push_live(self, message: dict, conv: str = DM_ID) -> None:
        cid = self.add(message, conv)
        for ws in list(self.sockets):
            if not ws.closed:
                await ws.send_json({"type": "message.created", "conversation_id": conv, "change_id": cid,
                                    "message": message})

    async def send_frame(self, frame: dict) -> None:
        """서버 프레임(membership.changed·error 등)을 모든 연결에 보낸다."""
        for ws in list(self.sockets):
            if not ws.closed:
                await ws.send_json(frame)

    async def close_all(self, code: int, reason: bytes = b"") -> None:
        for ws in list(self.sockets):
            await ws.close(code=code, message=reason)
        self.sockets.clear()

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
        if self.conversations is None:  # 구 서버 모양(conversations·display_name 없음)
            return web.json_response({"id": BOT_ID, "owner_user_id": OWNER_ID, "conversation_ids": [DM_ID]})
        return web.json_response({"id": BOT_ID, "owner_user_id": OWNER_ID, "display_name": self.display_name,
                                  "conversation_ids": [c["id"] for c in self.conversations],
                                  "conversations": list(self.conversations)})

    async def sync(self, request):
        self._log(request)
        after = int(request.query["after"])
        if self.sync_expired_below is not None and after < self.sync_expired_below:
            return web.json_response({"error": "cursor_expired"}, status=410)
        if self.sync_403 > 0:
            self.sync_403 -= 1
            return web.json_response({"error": "forbidden"}, status=403)
        latest = self.changes[-1][0] if self.changes else self.next_change
        through = int(request.query.get("through", latest))
        window = [c for c in self.changes if after < c[0] <= through]
        page, more = window[: self.page_size], len(window) > self.page_size
        nxt = page[-1][0] if (page and more) else through
        return web.json_response({
            "changes": [{"change_id": c, "conversation_id": conv, "message": m,
                         **({"op": self.ops[c]} if c in self.ops else {})} for c, conv, m in page],
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
        if self.post_status:
            status = self.post_status.pop(0)
            self.posts.append({**payload, "_status": status})
            headers = {"Retry-After": self.post_retry_after} if status == 429 else {}
            return web.json_response({"error": "forbidden" if status == 403 else "error"}, status=status,
                                     headers=headers)
        ok_so_far = sum(1 for p in self.posts if p["_status"] == 200)
        if self.post_429 > 0 or (self.ok_posts_before_429 is not None and ok_so_far >= self.ok_posts_before_429):
            self.post_429 = max(0, self.post_429 - 1)
            self.posts.append({**payload, "_status": 429})
            return web.json_response({"error": "rate_limited"}, status=429, headers={"Retry-After": "1"})
        self.posts.append({**payload, "_status": 200, "conversation_id": request.match_info["cid"]})
        msg = make_message(author=BOT_ID, body=payload["body"], thread_root_id=payload.get("thread_root_id"))
        msg["client_message_id"] = payload["client_message_id"]
        return web.json_response({"message": msg, "seq": 1, "change_id": self.add(msg), "mention_user_ids": []})

    async def upload(self, request):
        self._log(request)
        data = await request.read()
        rec = {"content_type": request.headers.get("Content-Type"), "size": len(data),
               "conversation_id": request.query.get("conversation_id")}
        if self.upload_delay:
            await asyncio.sleep(self.upload_delay)
        if self.upload_status:
            status = self.upload_status.pop(0)
            self.uploads.append({**rec, "_status": status})
            headers = {"Retry-After": self.upload_retry_after} if status == 429 else {}
            return web.json_response({"error": "error"}, status=status, headers=headers)
        aid = str(uuid.uuid4())
        self.uploads.append({**rec, "_status": 201, "attachment_id": aid})
        return web.json_response({"attachment_id": aid, "attachment": {
            "id": aid, "mime": rec["content_type"], "byte_size": len(data), "expires_at": iso(0), "expired": False}},
            status=201)

    async def download(self, request):
        self._log(request)
        aid = request.match_info["aid"]
        self.downloads.append(aid)
        if aid not in self.blobs:
            return web.json_response({"error": "not_found"}, status=404)
        mime, data = self.blobs[aid]
        return web.Response(body=data, content_type=mime)

    async def patch(self, request):
        self._log(request)
        self.patches.append((request.match_info["mid"], await request.json()))
        msg = make_message(author=BOT_ID, mid=request.match_info["mid"])
        return web.json_response({"message": msg, "seq": 1, "change_id": self.add(msg), "mention_user_ids": []})

    async def replies(self, request):
        self._log(request)
        mid = request.match_info["mid"]
        self.replies_calls.append(mid)
        if self.replies_status is not None:
            return web.json_response({"error": "forced"}, status=self.replies_status)
        root = next((m for _c, _conv, m in self.changes if m.get("id") == mid), None)
        if root is None:
            return web.json_response({"error": "not_found"}, status=404)
        return web.json_response({"root": root, "replies": [], "has_more": False})

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
                self.subscribed.append((frame["conversation_id"], after))
                for cid, conv, m in [c for c in self.changes if c[0] > after and c[1] == frame["conversation_id"]]:
                    await ws.send_json({"type": "message.created", "conversation_id": conv, "change_id": cid, "message": m})
                await ws.send_json({"type": "conversation.subscribed", "conversation_id": frame["conversation_id"],
                                    "through_cursor": self.next_change})
        return ws

    async def start(self) -> None:
        app = web.Application(client_max_size=11 * 1024 * 1024)
        p = "/api/bot/v1"
        app.router.add_get(f"{p}/me", self.me)
        app.router.add_get(f"{p}/sync", self.sync)
        app.router.add_get(f"{p}/sync/snapshot", self.snapshot)
        app.router.add_post(f"{p}/conversations/{{cid}}/messages", self.post)
        app.router.add_patch(f"{p}/messages/{{mid}}", self.patch)
        app.router.add_get(f"{p}/messages/{{mid}}/replies", self.replies)
        app.router.add_get(f"{p}/ws", self.ws)
        app.router.add_post(f"{p}/attachments", self.upload)
        app.router.add_get(f"{p}/attachments/{{aid}}", self.download)
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
def thread_server():
    """sync 테스트용 가짜 서버: 별도 스레드의 루프에서 돈다(Hermes cron `asyncio.run` 경로를 루프 없는 테스트에서 부르기 위해)."""
    loop = asyncio.new_event_loop()
    runner = threading.Thread(target=loop.run_forever, name="fake-bot-server", daemon=True)
    runner.start()
    srv = FakeBotServer()
    asyncio.run_coroutine_threadsafe(srv.start(), loop).result(5)
    yield srv
    asyncio.run_coroutine_threadsafe(srv.stop(), loop).result(5)
    loop.call_soon_threadsafe(loop.stop)
    runner.join(5)
    loop.close()


class FakeClock:
    """단조 시계 대역. 가짜 sleep이 시계를 앞당긴다(실제 대기 0)."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.now += delay


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
