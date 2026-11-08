"""ohmyslack 봇 리스너 HTTP·WS 클라이언트 (TRD R3.3 §5-2).

- 루프백(`127.0.0.1`·`localhost`)만 허용한다 — 봇 리스너 Host 허용목록과 같다(§5-2-3).
- `Authorization: Bearer`만 보낸다. `Origin`·`Cookie`는 보내지 않는다(§5-2-4: 있으면 서버가 400).
- 토큰·본문은 로그·예외 메시지에 싣지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlsplit

import aiohttp

logger = logging.getLogger(__name__)

API_PREFIX = "/api/bot/v1"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})
MAX_SEND_ATTEMPTS = 4
RETRY_AFTER_CAP_SECONDS = 60.0

Sleep = Callable[[float], Awaitable[None]]


class BotApiError(Exception):
    """봇 API 실패. 메시지에는 상태 코드·경로만 담는다(본문·토큰 금지)."""

    def __init__(self, status: int, path: str, retry_after: Optional[float] = None):
        super().__init__(f"ohmyslack bot api {path} -> HTTP {status}")
        self.status = status
        self.path = path
        self.retry_after = retry_after


class BotAuthError(BotApiError):
    """401/403 — 토큰 폐기·봇 비활성화 신호. 재시도하지 않는다(ADR-001 §3-f)."""


class CursorExpired(BotApiError):
    """410 — sync cursor 보존 경계 밖. snapshot으로 재초기화한다(TRD §3)."""


def validate_bot_url(url: str) -> str:
    """루프백 http URL만 통과시킨다. 그 외(원격 호스트·https 프록시·userinfo)는 ValueError."""
    parts = urlsplit((url or "").strip())
    if parts.scheme != "http":
        raise ValueError("OHMYSLACK_BOT_URL must use http:// on loopback")
    if parts.username or parts.password:
        raise ValueError("OHMYSLACK_BOT_URL must not contain credentials")
    host = (parts.hostname or "").lower()
    if host not in LOOPBACK_HOSTS:
        raise ValueError("OHMYSLACK_BOT_URL must point to 127.0.0.1 or localhost")
    if parts.port is None:
        raise ValueError("OHMYSLACK_BOT_URL must include the bot listener port")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("OHMYSLACK_BOT_URL must be a bare origin (no path/query)")
    return f"http://{host}:{parts.port}"


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return max(0.0, min(float(value), RETRY_AFTER_CAP_SECONDS))
    except ValueError:
        return None


def new_session() -> aiohttp.ClientSession:
    # DummyCookieJar: 응답 Set-Cookie를 저장·재전송하지 않는다(Cookie 헤더 미전송 보장).
    return aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar(), timeout=aiohttp.ClientTimeout(total=30))


class BotClient:
    """얇은 REST·WS 래퍼. 세션 수명은 호출자가 관리한다."""

    def __init__(self, base_url: str, token: str, session: aiohttp.ClientSession, *,
                 sleep: Sleep = asyncio.sleep):
        self._base = validate_bot_url(base_url)
        self._token = token
        self._session = session
        self._sleep = sleep

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    @staticmethod
    def _raise_for(status: int, path: str, retry_after: Optional[str]) -> None:
        if status in (401, 403):
            raise BotAuthError(status, path)
        if status == 410:
            raise CursorExpired(status, path)
        raise BotApiError(status, path, _parse_retry_after(retry_after))

    async def request(self, method: str, path: str, *, params: Optional[dict] = None,
                      json: Any = None) -> Any:
        url = f"{self._base}{API_PREFIX}{path}"
        async with self._session.request(method, url, params=params, json=json,
                                         headers=self._headers()) as resp:
            if resp.status >= 400:
                self._raise_for(resp.status, path, resp.headers.get("Retry-After"))
            return await resp.json()

    async def get_me(self) -> dict:
        return await self.request("GET", "/me")

    async def get_sync(self, after: int, through: Optional[int]) -> dict:
        params = {"after": str(after)}
        if through is not None:
            params["through"] = str(through)
        return await self.request("GET", "/sync", params=params)

    async def get_snapshot(self, conversation_id: str, *, before_seq: Optional[int] = None) -> dict:
        params = {"conversation_id": conversation_id}
        if before_seq is not None:
            params["before_seq"] = str(before_seq)
        return await self.request("GET", "/sync/snapshot", params=params)

    async def post_message(self, conversation_id: str, body: str, *,
                           thread_root_id: Optional[str] = None) -> dict:
        """멱등 재시도: 같은 `client_message_id`로 429(Retry-After)·5xx·연결 오류만 다시 보낸다."""
        payload: dict[str, Any] = {"client_message_id": str(uuid.uuid4()), "body": body}
        if thread_root_id:
            payload["thread_root_id"] = thread_root_id
        path = f"/conversations/{conversation_id}/messages"
        last_exc: Optional[Exception] = None
        for attempt in range(MAX_SEND_ATTEMPTS):
            try:
                return await self.request("POST", path, json=payload)
            except BotAuthError:
                raise
            except BotApiError as exc:
                if exc.status != 429 and exc.status < 500:
                    raise
                last_exc = exc
                delay = exc.retry_after if exc.retry_after is not None else float(2 ** attempt)
            except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as exc:
                last_exc = exc
                delay = float(2 ** attempt)
            if attempt + 1 < MAX_SEND_ATTEMPTS:
                logger.warning("ohmyslack: send retry %d/%d in %.1fs", attempt + 1, MAX_SEND_ATTEMPTS, delay)
                await self._sleep(delay)
        assert last_exc is not None
        raise last_exc

    async def patch_message(self, message_id: str, body: str) -> dict:
        return await self.request("PATCH", f"/messages/{message_id}", json={"body": body})

    async def ws_connect(self) -> aiohttp.ClientWebSocketResponse:
        url = f"{self._base}{API_PREFIX}/ws"
        try:
            # origin=None(기본)이라 Origin 헤더를 보내지 않는다.
            return await self._session.ws_connect(url, headers=self._headers(), heartbeat=25.0)
        except aiohttp.WSServerHandshakeError as exc:
            if exc.status in (401, 403):
                raise BotAuthError(exc.status, "/ws") from None
            raise BotApiError(exc.status, "/ws") from None
