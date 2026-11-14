"""ohmyslack 봇 리스너 HTTP·WS 클라이언트 (TRD R3.3 §5-2).

- 루프백(`127.0.0.1`·`localhost`)만 허용한다 — 봇 리스너 Host 허용목록과 같다(§5-2-3).
- `Authorization: Bearer`만 보낸다. `Origin`·`Cookie`는 보내지 않는다(§5-2-4: 있으면 서버가 400).
- 토큰·본문은 로그·예외 메시지에 싣지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
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


@dataclass(frozen=True)
class Attempt:
    """게시 시도 1회의 관찰(설계 r4 §Q1-3). outcome ∈ ack·not_sent·ambiguous·rate_limited·rejected·conflict·auth."""

    index: int
    outcome: str
    status: Optional[int]
    may_have_committed: bool


Observe = Callable[[Attempt], None]
_ACK_STATUSES = frozenset({200, 201})


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True


def _ack_message_id(body: Any, *, conversation_id: str, key: str, author_id: str) -> Optional[str]:
    """정상 ACK 구조 검사(설계 §Q1-2의 6개 조건) — 통과하면 메시지 ID, 아니면 None."""
    msg = body.get("message") if isinstance(body, dict) else None
    if not isinstance(msg, dict) or not _is_uuid(msg.get("id")):
        return None
    if msg.get("conversation_id") != conversation_id or msg.get("client_message_id") != key:
        return None
    if msg.get("author_id") != author_id or msg.get("thread_root_id") is not None:
        return None
    return str(msg["id"])


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
                           remaining: Optional[Callable[[], float]] = None,
                           client_message_id: Optional[str] = None,
                           observe: Optional[Observe] = None,
                           author_id: Optional[str] = None) -> Any:
        """멱등 재시도: 같은 `client_message_id`로 429(Retry-After)·5xx·연결 오류만 다시 보낸다.

        서버는 같은 키 재전송을 첨부 ID 집합까지 비교해 원래 메시지로 돌려준다(messages/repo.ts replay) → 중복 없음.
        `remaining`은 `_with_retry`와 같다(standalone 전체 deadline용, 기본은 기존 동작).
        `client_message_id`를 주면 그 키를 쓴다(없으면 호출마다 새 uuid4 — 기존 동작).
        `observe`를 주면 standalone 관찰 모드(설계 r4 §Q1): 리다이렉트를 따르지 않고, 시도마다 `Attempt`를 콜백에 남기며,
        예외 대신 정상 ACK의 메시지 ID(구조 검사 통과, `author_id` 필요) 또는 None을 돌려준다.
        """
        payload: dict[str, Any] = {"client_message_id": client_message_id or str(uuid.uuid4()), "body": body}
        if thread_root_id:
            payload["thread_root_id"] = thread_root_id
        if attachment_ids:
            payload["attachment_ids"] = list(attachment_ids)
        path = f"/conversations/{conversation_id}/messages"
        if observe is not None:
            return await self._post_observed(path, payload, conversation_id=conversation_id,
                                             author_id=str(author_id or ""), observe=observe, remaining=remaining)
        return await self._with_retry(lambda: self.request("POST", path, json=payload), "send", remaining=remaining)

    async def _post_once(self, index: int, path: str, payload: dict, *, conversation_id: str,
                         author_id: str) -> tuple[str, Optional[int], bool, Optional[str], float, Optional[str]]:
        """게시 1회 → (outcome, status, may_have_committed, 재시도 종류, 대기, 메시지 ID). 수신·파싱 예외는 호출자가 분류."""
        backoff = float(2 ** index)
        async with self._session.request("POST", f"{self._base}{API_PREFIX}{path}", json=payload,
                                         headers=self._headers(), allow_redirects=False) as resp:
            status = resp.status
            if status == 401:
                return "auth", status, False, None, 0.0, None
            if status == 409:
                return "conflict", status, False, None, 0.0, None
            if status == 429:
                retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                return "rate_limited", status, False, "wait", backoff if retry_after is None else retry_after, None
            if status >= 500:
                return "ambiguous", status, True, "backoff", backoff, None
            if status >= 400:
                return "rejected", status, False, None, 0.0, None
            if status not in _ACK_STATUSES or resp.url.path != f"{API_PREFIX}{path}":
                return "ambiguous", status, True, "once", 0.0, None  # 3xx·그 밖 2xx
            body = await resp.json()
        mid = _ack_message_id(body, conversation_id=conversation_id, key=payload["client_message_id"],
                              author_id=author_id)
        if mid is None:
            return "ambiguous", status, True, "once", 0.0, None  # 구조 위반·ID 없음
        return "ack", status, False, None, 0.0, mid

    async def _post_observed(self, path: str, payload: dict, *, conversation_id: str, author_id: str,
                             observe: Observe, remaining: Optional[Callable[[], float]]) -> Optional[str]:
        """standalone 게시 재시도(설계 r4 §Q1-3 표). 같은 payload(같은 키)만 다시 보내고, 판정은 `observe` 기록으로 한다.

        재시도: not_sent·연결/timeout·5xx는 백오프, 파싱·구조·3xx는 같은 키로 1회 더(대기 없음), ClientPayloadError는 안 함.
        429는 앞 시도에 모호성이 있으면 기다리지 않고 끝낸다(호출자가 확인 GET — 이력 GET은 rateGuard 없음).
        """
        maybe = False
        once_used = False
        for index in range(MAX_SEND_ATTEMPTS):
            try:
                outcome, status, may, retry, delay, mid = await self._post_once(
                    index, path, payload, conversation_id=conversation_id, author_id=author_id)
            except (aiohttp.ClientConnectorError, aiohttp.ConnectionTimeoutError):
                outcome, status, may, retry, delay, mid = "not_sent", None, False, "backoff", float(2 ** index), None
            except aiohttp.ClientPayloadError:
                outcome, status, may, retry, delay, mid = "ambiguous", None, True, None, 0.0, None
            except (aiohttp.ClientConnectionError, asyncio.TimeoutError):
                outcome, status, may, retry, delay, mid = "ambiguous", None, True, "backoff", float(2 ** index), None
            except (aiohttp.ContentTypeError, ValueError):
                outcome, status, may, retry, delay, mid = "ambiguous", None, True, "once", 0.0, None
            maybe = maybe or may
            observe(Attempt(index, outcome, status, may))
            if outcome == "ack":
                return mid
            if retry is None or (retry == "wait" and maybe) or (retry == "once" and once_used):
                return None
            once_used = once_used or retry == "once"
            if index + 1 >= MAX_SEND_ATTEMPTS or (remaining is not None and delay >= remaining()):
                return None
            if delay > 0:
                logger.warning("ohmyslack: send retry %d/%d in %.1fs", index + 1, MAX_SEND_ATTEMPTS, delay)
                await self._sleep(delay)
        return None

    async def history_contains(self, conversation_id: str, key: str, *, author_id: str,
                               timeout: float) -> tuple[str, Optional[str]]:
        """확인 GET 1회(재시도·리다이렉트 없음) → ("found", 메시지 ID) | ("not_found", None) | ("check_failed:<사유>", None).

        일치 = 같은 대화 ∧ 작성자 = 봇(`/me` id) ∧ 같은 키 ∧ 최상위. tombstone도 키를 보존하므로 found.
        취소(CancelledError) 외에는 절대 raise하지 않는다 — 확인 실패가 앞 청크의 확정 상태를 지우지 않게.
        """
        if timeout <= 0:
            return "check_failed:timeout", None
        path = f"/conversations/{conversation_id}/messages"
        try:
            async with asyncio.timeout(timeout):
                async with self._session.get(f"{self._base}{API_PREFIX}{path}", params={"limit": "100"},
                                             headers=self._headers(), allow_redirects=False) as resp:
                    if resp.status != 200:
                        reason = {401: "auth", 403: "forbidden"}.get(resp.status, f"http_{resp.status}")
                        return f"check_failed:{reason}", None
                    data = await resp.json()
        except asyncio.TimeoutError:
            return "check_failed:timeout", None
        except aiohttp.ClientConnectionError:
            return "check_failed:connection", None
        except (aiohttp.ClientError, ValueError):
            return "check_failed:parse", None
        messages = data.get("messages") if isinstance(data, dict) else None
        if not isinstance(messages, list):
            return "check_failed:parse", None
        for m in messages:
            if not isinstance(m, dict) or not _is_uuid(m.get("id")):
                continue
            if (m.get("conversation_id") == conversation_id
                    and m.get("author_id") == author_id
                    and m.get("client_message_id") == key
                    and m.get("thread_root_id") is None):
                return "found", str(m["id"])
        return "not_found", None

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
