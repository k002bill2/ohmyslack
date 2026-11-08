"""ohmyslack 플랫폼 어댑터 (W-20, ADR-001 §3-c·d·e·f·h·j, TRD R3.3 §5-2).

인바운드: `message.created`만. 자기 echo·owner 외 작성자·중복 id는 버린다(owner 판정은 `author_id`만,
TRD §5-2-8). `created_at`이 15분을 넘은 지시는 실행하지 않고 대화별 안내 1건(ADR D-7).
세션: 최상위 → `thread_id = message.id`, 답글 → `thread_id = thread_root_id`(ADR §3-d).
`/approve`·`/deny` 등 텍스트는 해석하지 않고 그대로 Hermes에 넘긴다(D-5).
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

import aiohttp

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import extra_or_secret, get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator

from .client import BotApiError, BotAuthError, BotClient, CursorExpired, new_session, validate_bot_url
from .cursor import CursorState, CursorStore, RECENT_IDS_MAX

logger = logging.getLogger(__name__)

PLATFORM_NAME = "ohmyslack"
TOKEN_ENV = "OHMYSLACK_BOT_TOKEN"
URL_ENV = "OHMYSLACK_BOT_URL"
PORT_ENV = "OHMYSLACK_BOT_PORT"
BACKLOG_LIMIT_SECONDS = 15 * 60
SNAPSHOT_MAX_PAGES = 50
BACKOFF_START, BACKOFF_CAP = 2.0, 60.0
BACKLOG_NOTICE = "오프라인 동안 받은 {n}건은 처리하지 않았습니다"
ATTACHMENT_FALLBACK = "(첨부 전송은 아직 지원하지 않습니다)"


def backoff_delay(attempt: int, rand: Callable[[], float] = random.random) -> float:
    """2→4→…→60초 지수 백오프 + 최대 10% 지터."""
    exponent = min(max(0, attempt), 6)  # 2*2**5=64 ≥ 상한 — 큰 지수 계산(OverflowError) 방지
    base = min(BACKOFF_CAP, BACKOFF_START * (2 ** exponent))
    return base + base * 0.1 * rand()


def _epoch(iso: Any) -> Optional[float]:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def default_cursor_path() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "ohmyslack" / "cursor.json"


def resolve_bot_url(extra: Optional[dict]) -> str:
    """`OHMYSLACK_BOT_URL` → 없으면 `http://127.0.0.1:<OHMYSLACK_BOT_PORT>`. 루프백 외는 ValueError."""
    url = str(extra_or_secret(extra, "url", URL_ENV, "") or "").strip()
    if not url:
        port = str(extra_or_secret(extra, "port", PORT_ENV, "") or "").strip()
        if not port:
            raise ValueError("set OHMYSLACK_BOT_URL or OHMYSLACK_BOT_PORT")
        url = f"http://127.0.0.1:{port}"
    return validate_bot_url(url)


class OhmySlackAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = 4000

    def __init__(self, config: PlatformConfig, *, session_factory: Callable[[], aiohttp.ClientSession] = new_session,
                 sleep=asyncio.sleep, clock: Callable[[], float] = time.time,
                 rand: Callable[[], float] = random.random, cursor_path: Optional[Path] = None):
        super().__init__(config, Platform(PLATFORM_NAME))
        extra = getattr(config, "extra", None) or {}
        self._token: str = (getattr(config, "token", None) or get_scoped_secret(TOKEN_ENV, "") or "").strip()
        self._config_error: Optional[str] = None if self._token else "OHMYSLACK_BOT_TOKEN is not set"
        try:
            self._base_url = resolve_bot_url(extra)
        except ValueError as exc:
            self._base_url, self._config_error = "", str(exc)
        self._session_factory, self._sleep, self._clock, self._rand = session_factory, sleep, clock, rand
        self._cursor = CursorStore(cursor_path or default_cursor_path())
        self._dedup = MessageDeduplicator(max_size=5000, ttl_seconds=7 * 24 * 3600)
        self._session: Optional[aiohttp.ClientSession] = None
        self._client: Optional[BotClient] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stopping = False
        self._me_id = self._owner_id = ""
        self._conversation_ids: tuple[str, ...] = ()
        self._watermark = 0
        self._recent: tuple[str, ...] = ()
        self._root_of: dict[str, str] = {}
        self._backlog: dict[str, int] = {}

    # ---------- lifecycle ----------
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._config_error:
            self._set_fatal_error("config_invalid", self._config_error, retryable=False)
            return False
        self._stopping = False
        self._session = self._session_factory()
        self._client = BotClient(self._base_url, self._token, self._session, sleep=self._sleep)
        try:
            ws = await self._open()
        except BotAuthError:
            await self._close_session()
            self._set_fatal_error("unauthorized", "ohmyslack bot token rejected (401/403)", retryable=False)
            return False
        except Exception as exc:  # noqa: BLE001 — 재시도는 게이트웨이 watcher 몫
            logger.warning("ohmyslack: connect failed (%s)", type(exc).__name__)
            await self._close_session()
            return False
        self._mark_connected()
        self._reader_task = asyncio.create_task(self._reader_loop(ws))
        return True

    async def disconnect(self) -> None:
        self._stopping = True
        task, self._reader_task = self._reader_task, None
        if task and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        await self._close_session()
        self._mark_disconnected()

    async def _close_session(self) -> None:
        session, self._session = self._session, None
        if session is not None and not session.closed:
            await session.close()

    async def _open(self) -> aiohttp.ClientWebSocketResponse:
        """me → catch-up(410이면 snapshot) → WS 구독. 실패는 예외로 올린다."""
        assert self._client is not None
        me = await self._client.get_me()
        self._me_id = str(me.get("id") or me.get("bot_id") or "")
        self._owner_id = str(me.get("owner_user_id") or "")
        self._conversation_ids = tuple(str(c) for c in me.get("conversation_ids") or ())
        if not self._me_id or not self._owner_id:
            raise BotApiError(502, "/me")
        state = self._cursor.load()
        if state is not None:
            for mid in state.recent_ids:
                self._dedup.is_duplicate(mid)
            self._recent = state.recent_ids
        try:
            if state is None:
                raise CursorExpired(410, "/sync")
            await self._catch_up(state.change_id)
        except CursorExpired:
            start = await self._snapshot_init(state)
            await self._catch_up(start)
        ws = await self._client.ws_connect()
        for cid in self._conversation_ids:
            await ws.send_json({"type": "conversation.subscribe", "conversation_id": cid,
                                "after_cursor": self._watermark})
        await self._flush_backlog()
        return ws

    async def _reader_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        attempt = 0
        while not self._stopping:
            try:
                await self._consume(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("ohmyslack: websocket dropped (%s)", type(exc).__name__)
            finally:
                await ws.close()
            while not self._stopping:
                await self._sleep(backoff_delay(attempt, self._rand))
                attempt += 1
                try:
                    ws = await self._open()
                    attempt = 0
                    break
                except asyncio.CancelledError:
                    raise
                except BotAuthError:
                    self._set_fatal_error("unauthorized", "ohmyslack bot token rejected (401/403)", retryable=False)
                    await self._notify_fatal_error()
                    return
                except Exception as exc:  # noqa: BLE001
                    logger.warning("ohmyslack: reconnect failed (%s)", type(exc).__name__)

    async def _consume(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
                continue
            try:
                frame = json.loads(msg.data)
            except ValueError:
                continue
            kind = frame.get("type")
            if kind == "message.created":
                await self._ingest(str(frame.get("conversation_id") or ""), frame.get("message") or {})
                if int(frame.get("change_id") or 0) > self._watermark:
                    # 실시간 수신 후 저장 커서 전진은 REST watermark로만 한다(TRD §4: 대화 간 live 순서 비보장).
                    await self._catch_up(self._watermark)
                    await self._flush_backlog()
            elif kind == "conversation.subscribed":
                await self._flush_backlog()
            elif kind == "sync.required":
                await self._catch_up(self._watermark)
                await self._flush_backlog()
            elif kind == "error" and frame.get("code") == "cursor_expired":
                raise CursorExpired(410, "/ws")

    # ---------- catch-up ----------
    async def _catch_up(self, after: int) -> None:
        assert self._client is not None
        through: Optional[int] = None
        cursor = after
        while True:
            page = await self._client.get_sync(cursor, through)
            if through is None:
                through = int(page["through_cursor"])
            changes = page.get("changes") or ()
            # 답글 변경 시 서버는 원문 projection도 함께 싣는다(sync/repo.ts:75-78) — 그 원문은 새 지시가 아니다.
            reply_roots = {str((c.get("message") or {}).get("thread_root_id") or "") for c in changes}
            for change in changes:
                m = change.get("message") or {}
                aux_root = m.get("thread_root_id") is None and str(m.get("id") or "") in reply_roots
                await self._ingest(str(change.get("conversation_id") or ""), m, aux_root=aux_root)
            cursor = int(page["next_cursor"])
            self._save_cursor(cursor)
            if not page.get("has_more"):
                return

    async def _snapshot_init(self, prev: Optional[CursorState]) -> int:
        """첫 연결·410: snapshot 메시지는 실행하지 않는다. 410이면 오프라인 이후 owner 지시 수만 센다."""
        assert self._client is not None
        start: Optional[int] = None
        for cid in self._conversation_ids:
            snap = await self._client.get_snapshot(cid)
            cur = int(snap["snapshot_cursor"])
            start = cur if start is None else min(start, cur)
            for _page in range(SNAPSHOT_MAX_PAGES):
                oldest = self._count_snapshot_page(cid, snap.get("messages") or (), prev)
                # 410일 때만 오프라인 시점까지 과거 페이지를 더 읽어 센다(첫 연결은 실행·안내 없음).
                if prev is None or not snap.get("has_more") or snap.get("next_before_seq") is None \
                        or oldest < prev.saved_at:
                    break
                snap = await self._client.get_snapshot(cid, before_seq=int(snap["next_before_seq"]))
        start = start or 0
        self._save_cursor(start)
        return start

    def _count_snapshot_page(self, cid: str, messages, prev: Optional[CursorState]) -> float:
        oldest = float("inf")
        for m in messages:
            mid = str(m.get("id") or "")
            fresh = not self._dedup.is_duplicate(mid)
            created = _epoch(m.get("created_at")) or 0.0
            oldest = min(oldest, created)
            if prev is not None and fresh and self._is_owner_instruction(m) and created >= prev.saved_at:
                self._backlog[cid] = self._backlog.get(cid, 0) + 1
        return oldest

    # ---------- inbound ----------
    def _is_owner_instruction(self, m: dict) -> bool:
        author = str(m.get("author_id") or "")
        return (bool(author) and author != self._me_id and author == self._owner_id
                and m.get("deleted_at") is None and m.get("body") is not None)

    async def _ingest(self, conversation_id: str, m: dict, *, aux_root: bool = False) -> None:
        mid = str(m.get("id") or "")
        if not mid or not conversation_id or not self._is_owner_instruction(m):
            return
        if self._dedup.is_duplicate(mid):
            return
        if m.get("edited_at") is not None:
            # sync change에는 op가 없다 — 수정 projection은 새 지시로 실행하지 않는다(WS message.updated와 동일).
            self._remember(mid)
            return
        created = _epoch(m.get("created_at"))
        if created is None or self._clock() - created > BACKLOG_LIMIT_SECONDS:
            if not aux_root:
                self._backlog[conversation_id] = self._backlog.get(conversation_id, 0) + 1
            self._remember(mid)
            return
        thread_id = str(m.get("thread_root_id") or mid)
        self._root_of[mid] = thread_id
        source = self.build_source(chat_id=conversation_id, chat_type="dm", user_id=str(m["author_id"]),
                                   thread_id=thread_id, message_id=mid)
        event = MessageEvent(text=str(m["body"]), message_type=MessageType.TEXT, user_id=str(m["author_id"]),
                             source=source, raw_message=m, message_id=mid)
        try:
            await self.handle_message(event)
        except BaseException:
            # 인계 실패: 중복 방지 등록을 풀고 커서도 전진시키지 않는다 → 재연결 catch-up에서 재전달.
            self._dedup.discard(mid)
            raise
        self._remember(mid)

    def _remember(self, mid: str) -> None:
        self._recent = (self._recent + (mid,))[-RECENT_IDS_MAX:]
        self._save_cursor(self._watermark)

    def _save_cursor(self, change_id: int) -> None:
        self._watermark = max(self._watermark, int(change_id))
        self._cursor.save(CursorState(change_id=self._watermark, saved_at=self._clock(), recent_ids=self._recent))

    async def _flush_backlog(self) -> None:
        for cid, n in list(self._backlog.items()):
            if n <= 0:
                self._backlog.pop(cid, None)
                continue
            result = await self.send(cid, BACKLOG_NOTICE.format(n=n))
            if result.success:  # 실패분은 보존해 다음 flush(재연결·구독 ACK)에서 다시 보낸다
                self._backlog[cid] = self._backlog.get(cid, n) - n
                if self._backlog[cid] <= 0:
                    self._backlog.pop(cid, None)

    # ---------- outbound ----------
    def _thread_root(self, reply_to: Optional[str], metadata: Optional[dict]) -> Optional[str]:
        meta_thread = metadata.get("thread_id") if isinstance(metadata, dict) else None
        if meta_thread:
            return self._root_of.get(str(meta_thread), str(meta_thread))
        if reply_to:
            return self._root_of.get(str(reply_to), str(reply_to))
        return None

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="ohmyslack: not connected", retryable=True, error_kind="transient")
        root = self._thread_root(reply_to, metadata)
        ids: list[str] = []
        try:
            for chunk in self.truncate_message(content or "", self.MAX_MESSAGE_LENGTH):
                res = await self._client.post_message(str(chat_id), chunk, thread_root_id=root)
                ids.append(str((res.get("message") or {}).get("id") or ""))
        except BotAuthError:
            return SendResult(success=False, error="ohmyslack: unauthorized", error_kind="forbidden")
        except BotApiError as exc:
            limited = exc.status == 429
            return self._failed_send(ids, f"ohmyslack: HTTP {exc.status}", retryable=limited,
                                     retry_after=exc.retry_after, kind="rate_limited" if limited else "unknown")
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return self._failed_send(ids, f"ohmyslack: {type(exc).__name__}", retryable=True, kind="transient")
        for mid in ids:
            if root:
                self._root_of[mid] = root
        return SendResult(success=True, message_id=ids[-1] if ids else None,
                          continuation_message_ids=tuple(ids) if len(ids) > 1 else ())

    @staticmethod
    def _failed_send(ids: list[str], error: str, *, retryable: bool, kind: str,
                     retry_after: Optional[float] = None) -> SendResult:
        if ids:
            # 일부 청크가 이미 게시됨: base `_send_with_retry`가 전체를 다시 보내 중복 게시하지 않도록
            # 재시도 불가로 돌려주고 게시된 id를 싣는다(Codex r2 P2).
            return SendResult(success=False, error=f"{error} (partial: {len(ids)} chunk(s) posted)",
                              retryable=False, error_kind=kind, continuation_message_ids=tuple(ids),
                              raw_response={"partial_message_ids": list(ids)})
        return SendResult(success=False, error=error, retryable=retryable, retry_after=retry_after,
                          error_kind=kind)

    async def edit_message(self, chat_id: str, message_id: str, content: str, *,
                           finalize: bool = False) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="ohmyslack: not connected", retryable=True)
        if len(content or "") > self.MAX_MESSAGE_LENGTH:
            return SendResult(success=False, error="ohmyslack: too long for edit", error_kind="too_long")
        try:
            await self._client.patch_message(str(message_id), content or "")
        except BotApiError as exc:
            return SendResult(success=False, error=f"ohmyslack: HTTP {exc.status}")
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return SendResult(success=False, error=f"ohmyslack: {type(exc).__name__}", retryable=True)
        return SendResult(success=True, message_id=str(message_id))

    async def _attachment_fallback(self, method: str, chat_id: str, caption: Optional[str],
                                   reply_to: Optional[str], metadata: Optional[dict]) -> SendResult:
        # 경로·캡션·토큰은 로그에 남기지 않는다(W-21 전까지 첨부 미지원).
        logger.warning("ohmyslack: %s is not supported yet; sending text fallback", method)
        text = f"{caption}\n{ATTACHMENT_FALLBACK}" if caption else ATTACHMENT_FALLBACK
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._attachment_fallback("send_voice", chat_id, caption, reply_to, metadata)

    async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None,
                            metadata=None, **kwargs):
        return await self._attachment_fallback("send_document", chat_id, caption, reply_to, metadata)

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._attachment_fallback("send_image_file", chat_id, caption, reply_to, metadata)

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._attachment_fallback("send_video", chat_id, caption, reply_to, metadata)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": "Jarvis", "type": "dm", "chat_id": str(chat_id)}


async def standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                          media_files=None, force_document: bool = False,
                          session_factory: Callable[[], aiohttp.ClientSession] = new_session) -> dict:
    """게이트웨이 밖 cron 전달: owner DM(홈 채널)에 최상위 메시지. `thread_id`·첨부는 쓰지 않는다."""
    from gateway.platforms._shared import send_error
    extra = getattr(pconfig, "extra", None) or {}
    token = (getattr(pconfig, "token", None) or get_scoped_secret(TOKEN_ENV, "") or "").strip()
    if not token or not chat_id:
        return send_error("ohmyslack standalone send: OHMYSLACK_BOT_TOKEN and home channel must be set")
    try:
        base = resolve_bot_url(extra)
    except ValueError as exc:
        return send_error(f"ohmyslack standalone send: {exc}")
    async with session_factory() as session:
        client = BotClient(base, token, session)
        ids = []
        try:
            for chunk in BasePlatformAdapter.truncate_message(message or "", OhmySlackAdapter.MAX_MESSAGE_LENGTH):
                res = await client.post_message(str(chat_id), chunk)
                ids.append(str((res.get("message") or {}).get("id") or ""))
        except BotApiError as exc:
            return send_error(f"ohmyslack standalone send: HTTP {exc.status}")
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return send_error(f"ohmyslack standalone send: {type(exc).__name__}")
    return {"success": True, "message_id": ids[-1] if ids else None}
