"""ohmyslack 봇 리스너 HTTP·WS 클라이언트 (TRD R3.3 §5-2).

- 루프백(`127.0.0.1`·`localhost`)만 허용한다 — 봇 리스너 Host 허용목록과 같다(§5-2-3).
- `Authorization: Bearer`만 보낸다. `Origin`·`Cookie`는 보내지 않는다(§5-2-4: 있으면 서버가 400).
- 토큰·본문은 로그·예외 메시지에 싣지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable, Optional, TypeVar
from urllib.parse import urlsplit

import aiohttp

logger = logging.getLogger(__name__)

API_PREFIX = "/api/bot/v1"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})
MAX_SEND_ATTEMPTS = 4
RETRY_AFTER_CAP_SECONDS = 60.0
ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024  # shared/attachments.ts ATTACHMENT_MAX_BYTES (ADR-001 §3-g)
_READ_CHUNK = 64 * 1024

Sleep = Callable[[float], Awaitable[None]]
T = TypeVar("T")


class BotApiError(Exception):
    """봇 API 실패. 메시지에는 상태 코드·경로만 담는다(본문·토큰 금지)."""

    def __init__(self, status: int, path: str, retry_after: Optional[float] = None):
        super().__init__(f"ohmyslack bot api {path} -> HTTP {status}")
        self.status = status
        self.path = path
        self.retry_after = retry_after


class BotAuthError(BotApiError):
    """401 — 토큰 폐기·봇 비활성화 신호. 재시도하지 않는다(ADR-001 §3-f)."""


class BotForbidden(BotApiError):
    """403 — 그 동작만 권한 거부. 인증 실패가 아니므로 연결·어댑터를 멈추지 않는다(TRD R3.3 §5-2)."""


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
        if status == 401:
            raise BotAuthError(status, path)
        if status == 403:
            raise BotForbidden(status, path)
        if status == 410:
            raise CursorExpired(status, path)
        raise BotApiError(status, path, _parse_retry_after(retry_after))

    async def request(self, method: str, path: str, *, params: Optional[dict] = None,
                      json: Any = None, data: Optional[bytes] = None,
                      content_type: Optional[str] = None) -> Any:
        url = f"{self._base}{API_PREFIX}{path}"
        headers = self._headers()
        if content_type:
            headers["Content-Type"] = content_type
        async with self._session.request(method, url, params=params, json=json, data=data,
                                         headers=headers) as resp:
            if resp.status >= 400:
                self._raise_for(resp.status, path, resp.headers.get("Retry-After"))
            return await resp.json()

    async def _with_retry(self, call: Callable[[], Awaitable[T]], label: str, *,
                          remaining: Optional[Callable[[], float]] = None) -> T:
        """429(Retry-After)·5xx·연결 오류만 최대 MAX_SEND_ATTEMPTS회 다시 시도한다. 그 외 4xx·401은 즉시 올린다.

        `remaining`(남은 시간 예산, 초)을 주면 재시도 대기가 그보다 길 때 기다리지 않고 마지막 오류를 올린다.
        기본값 None은 기존 동작(상한까지 대기)이다.
        """
        last_exc: Optional[Exception] = None
        for attempt in range(MAX_SEND_ATTEMPTS):
            try:
                return await call()
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
                if remaining is not None and delay >= remaining():
                    break
                logger.warning("ohmyslack: %s retry %d/%d in %.1fs", label, attempt + 1, MAX_SEND_ATTEMPTS, delay)
                await self._sleep(delay)
        assert last_exc is not None
        raise last_exc

    async def get_me(self) -> dict:
        return await self.request("GET", "/me")

    async def get_sync(self, after: int, through: Optional[int]) -> dict:
        params = {"after": str(after)}
        if through is not None:
            params["through"] = str(through)
        return await self.request("GET", "/sync", params=params)

    async def get_replies(self, root_id: str, *, limit: int = 1) -> dict:
        """`GET messages/{root_id}/replies` → `{root, replies, has_more}`(TRD §5-2-6). 재시도 없이 1회만 부른다."""
        return await self.request("GET", f"/messages/{root_id}/replies", params={"limit": str(limit)})

    async def get_snapshot(self, conversation_id: str, *, before_seq: Optional[int] = None) -> dict:
        params = {"conversation_id": conversation_id}
        if before_seq is not None:
            params["before_seq"] = str(before_seq)
        return await self.request("GET", "/sync/snapshot", params=params)

    async def post_message(self, conversation_id: str, body: str, *,
                           thread_root_id: Optional[str] = None,
                           attachment_ids: Optional[list[str]] = None,
                           remaining: Optional[Callable[[], float]] = None) -> dict:
        """멱등 재시도: 같은 `client_message_id`로 429(Retry-After)·5xx·연결 오류만 다시 보낸다.

        서버는 같은 키 재전송을 첨부 ID 집합까지 비교해 원래 메시지로 돌려준다(messages/repo.ts replay) → 중복 없음.
        `remaining`은 `_with_retry`와 같다(standalone 전체 deadline용, 기본은 기존 동작).
        """
        payload: dict[str, Any] = {"client_message_id": str(uuid.uuid4()), "body": body}
        if thread_root_id:
            payload["thread_root_id"] = thread_root_id
        if attachment_ids:
            payload["attachment_ids"] = list(attachment_ids)
        path = f"/conversations/{conversation_id}/messages"
        return await self._with_retry(lambda: self.request("POST", path, json=payload), "send", remaining=remaining)

    async def upload_attachment(self, conversation_id: str, data: bytes, mime: str, *,
                                filename: Optional[str] = None,
                                remaining: Optional[Callable[[], float]] = None) -> dict:
        """원시 바이트 업로드 → 미결속 첨부(`attachment_id`). 재시도는 post_message와 같은 정책.

        업로드에는 멱등 키가 없어, 응답 유실 뒤 재시도하면 미결속 첨부가 하나 더 생길 수 있다 — 결속되지 않은 것은
        서버가 1시간 뒤 정리한다(ATTACHMENT_UNBOUND_TTL_MS). 메시지는 하나만 만들어진다.
        `remaining`은 `_with_retry`와 같다(standalone 시간 예산용, 기본은 기존 동작).
        `filename`은 자리만 둔다(W-27 문서 업로드가 `X-Attachment-Filename`으로 채울 예정, TRD §6-1-1 (5)) — 지금은
        보내지 않는다(미디어는 헤더가 필요 없다).
        """
        del filename  # 아직 쓰지 않는다(위 참조)
        return await self._with_retry(
            lambda: self.request("POST", "/attachments", params={"conversation_id": conversation_id},
                                 data=data, content_type=mime), "upload", remaining=remaining)

    async def download_attachment(self, attachment_id: str, *, max_bytes: int = ATTACHMENT_MAX_BYTES) -> bytes:
        """첨부 바이트를 상한까지만 읽는다(Content-Length·누적 크기 모두 검사). 넘으면 BotApiError(413)."""
        path = f"/attachments/{attachment_id}"
        url = f"{self._base}{API_PREFIX}{path}"
        async with self._session.get(url, headers=self._headers()) as resp:
            if resp.status >= 400:
                self._raise_for(resp.status, path, resp.headers.get("Retry-After"))
            if resp.content_length is not None and resp.content_length > max_bytes:
                raise BotApiError(413, path)
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.content.iter_chunked(_READ_CHUNK):
                total += len(chunk)
                if total > max_bytes:
                    raise BotApiError(413, path)
                chunks.append(chunk)
            return b"".join(chunks)

    async def patch_message(self, message_id: str, body: str) -> dict:
        return await self.request("PATCH", f"/messages/{message_id}", json={"body": body})

    async def ws_connect(self) -> aiohttp.ClientWebSocketResponse:
        url = f"{self._base}{API_PREFIX}/ws"
        try:
            # origin=None(기본)이라 Origin 헤더를 보내지 않는다.
            return await self._session.ws_connect(url, headers=self._headers(), heartbeat=25.0)
        except aiohttp.WSServerHandshakeError as exc:
            if exc.status == 401:
                raise BotAuthError(exc.status, "/ws") from None
            raise BotApiError(exc.status, "/ws") from None
