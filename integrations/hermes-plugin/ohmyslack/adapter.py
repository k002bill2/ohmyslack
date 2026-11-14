"""ohmyslack 플랫폼 어댑터 (W-20, ADR-001 §3-c·d·e·f·h·j, TRD R3.3 §5-2).

인바운드: `message.created`만. 자기 echo·owner 외 작성자·중복 id는 버린다(owner 판정은 `author_id`만,
TRD §5-2-8). `created_at`이 15분을 넘은 지시는 실행하지 않고 대화별 안내 1건(ADR D-7).
세션: 최상위 → `thread_id = message.id`, 답글 → `thread_id = thread_root_id`(ADR §3-d).
`/approve`·`/deny` 등 텍스트는 해석하지 않고 그대로 Hermes에 넘긴다(D-5).
채널(BOT_CHANNEL_SPEC §5): `/me.conversations`의 종류로 dm/channel을 구분하고 모르는 대화는 무시한다. 채널은
owner 글 중 서버 `mention_user_ids`에 봇이 있는 것과, 봇 스레드의 owner 비멘션 답글(§10 Q5 변경 2026-11-13)만 받고,
본문 맨 앞 `@<봇 표시 이름>` 1개를 지운다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import stat
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

import aiohttp

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import extra_or_secret, get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator

from .client import (ATTACHMENT_MAX_BYTES, Attempt, BotApiError, BotAuthError, BotClient, CursorExpired, new_session,
                     validate_bot_url)
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
# 허용목록(shared/attachments.ts ATTACHMENT_MIMES, ADR-001 §3-g): 확장자 → MIME. 서버가 매직 바이트로 다시 판정한다.
VOICE_TYPES = {".mp3": "audio/mpeg"}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
INBOUND_IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
ATTACHMENTS_PER_MESSAGE_MAX = 4  # shared/attachments.ts
SYNC_OPS = frozenset({"create", "edit", "delete"})  # shared/sync.ts SYNC_CHANGE_OPS
CHAT_KINDS = frozenset({"dm", "channel"})  # shared/bots.ts botMeSchema conversations[].kind
# 봇 스레드 이어받기(BOT_CHANNEL_SPEC §10 Q5 변경 2026-11-13): 기억하는 루트 수는 dedupe 기록 상한과 같은 크기로 둔다.
BOT_THREADS_MAX = RECENT_IDS_MAX
# 음성·오류 조회 결과 캐시 수명: 같은 루트의 연속 답글이 매번 조회하지 않게 하되, 일시 오류가 오래 굳지 않을 만큼 짧게.
NOT_BOT_THREAD_TTL_SECONDS = 60.0
# 루트 조회 상한: 수신 루프를 오래 붙잡지 않도록 세션 기본(30초)보다 짧게. 넘기면 거부(fail-closed).
ROOT_LOOKUP_TIMEOUT_SECONDS = 5.0
WS_CLOSE_TOKEN_INVALID = 1008  # 토큰 폐기·봇 비활성화·회전(token_revoked·session_ended) — 재연결하지 않는다


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


AttachmentRead = tuple[Optional[tuple[bytes, str, str]], str]


def read_attachment_file(path: Any, allowed: dict[str, str],
                         declared_mime: Optional[str] = None) -> AttachmentRead:
    """Hermes가 넘긴 경로를 첨부로 읽는다 → ((바이트, MIME, 파일명) | None, 거절 사유).

    사유(warnings enum): 성공 "", 없는 파일 `not_found`, 상한 초과 `too_large`, 그 외(형식·링크·비정규·빈 파일) `rejected`.
    심볼릭 링크는 따라가지 않고(O_NOFOLLOW), 연 fd를 fstat해 정규 파일·크기를 확인한 뒤 상한+1바이트까지만 읽는다
    (검사와 읽기 사이 파일 교체·성장도 막는다). 사유도 같은 fd의 fstat으로 정한다 — 경로를 다시 조회(lstat)하지 않는다.
    base `validate_media_delivery_path`를 거치지 않는 호출 경로의 이중 방어. 파일 시스템 호출이 있으므로
    루프 스레드에서 부르지 않는다(`_read_off_loop`).
    """
    try:
        name = os.path.basename(os.fspath(path))
    except TypeError:
        return None, "rejected"
    mime = allowed.get(os.path.splitext(name)[1].lower())
    if mime is None or (declared_mime and declared_mime.lower() != mime):
        return None, "rejected"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None, "not_found"
    except (OSError, ValueError):
        return None, "rejected"
    try:
        info = os.fstat(fd)
        if stat.S_ISREG(info.st_mode) and info.st_size > ATTACHMENT_MAX_BYTES:
            return None, "too_large"
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            return None, "rejected"
        chunks: list[bytes] = []
        remaining = ATTACHMENT_MAX_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    except OSError:
        return None, "rejected"
    finally:
        os.close(fd)
    if len(data) > ATTACHMENT_MAX_BYTES:
        return None, "too_large"
    if not data:
        return None, "rejected"
    return (data, mime, name), ""


async def _read_off_loop(path: Any, allowed: dict[str, str], declared_mime: Optional[str] = None) -> AttachmentRead:
    """`read_attachment_file`을 daemon 스레드 1개에서 실행하고 결과를 기다린다(루프 스레드 파일 시스템 호출 0).

    기본 executor(`asyncio.to_thread`)를 쓰지 않는다: `asyncio.run` 종료가 executor 스레드를 기한 없이 join하므로
    멈춘 파일 시스템 읽기가 Hermes cron 반환을 붙잡는다. daemon 스레드는 join 대상이 아니다 — 멈춘 스레드는 남지만
    호출당 최대 ATTACHMENTS_PER_MESSAGE_MAX개로 상한이 있다. 호출자가 기다리기를 포기(취소)해도 결과는 버려진다.
    """
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()

    def deliver(result: AttachmentRead) -> None:
        if not fut.done():  # 취소된 future에 set_result하면 InvalidStateError
            fut.set_result(result)

    def run() -> None:
        try:
            result = read_attachment_file(path, allowed, declared_mime)
        except Exception:  # 예상 밖 예외에도 future가 영원히 미결로 남지 않게
            result = (None, "rejected")
        if loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(deliver, result)
        except RuntimeError:  # is_closed 확인 뒤 닫힌 경쟁
            pass

    threading.Thread(target=run, name="ohmyslack-attachment-read", daemon=True).start()
    return await fut


def strip_mention_token(body: str, display_name: str) -> str:
    """본문 맨 앞 `@<봇 표시 이름>` 토큰 1개만 지우고 앞뒤 공백을 다듬는다(BOT_CHANNEL_SPEC §5-3).

    경계는 웹 멘션 규칙과 같다: 이름 뒤가 문자·숫자·`_`이면 멘션이 아니다(`@Jarvis님`은 그대로).
    """
    text = (body or "").strip()
    if not display_name:
        return text
    match = re.match(rf"@{re.escape(display_name)}(?!\w)", text)
    return text[match.end():].strip() if match else text


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True


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
        self._kinds: dict[str, str] = {}  # conversation_id → "dm" | "channel" (/me.conversations)
        self._names: dict[str, str] = {}  # conversation_id → 채널 이름 (/me.conversations[].name, 구 서버면 비어 있음)
        self._display_name = ""
        self._watermark = 0
        self._recent: tuple[str, ...] = ()
        self._root_of: dict[str, str] = {}
        self._backlog: dict[str, int] = {}
        self._bot_threads: dict[str, None] = {}  # 이번 프로세스에서 owner 지시를 넘긴 채널 스레드 루트(삽입 순서 = 오래된 순)
        self._not_bot_threads: dict[str, float] = {}  # 조회 결과 음성·오류인 루트 → 캐시 만료 시각

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
            self._set_fatal_error("unauthorized", "ohmyslack bot token rejected (401)", retryable=False)
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
        await self._refresh_me()
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

    async def _refresh_me(self) -> None:
        """`GET /me` → 봇·owner id, 표시 이름, 대화 종류 맵. 대화 종류가 없는 응답(구 서버)은 거부한다(§5-1)."""
        assert self._client is not None
        me = await self._client.get_me()
        me_id = str(me.get("id") or me.get("bot_id") or "")
        owner_id = str(me.get("owner_user_id") or "")
        conversations = me.get("conversations")
        if not me_id or not owner_id or not isinstance(conversations, list):
            raise BotApiError(502, "/me")
        kinds = {str(c["id"]): str(c["kind"]) for c in conversations
                 if isinstance(c, dict) and c.get("id") and c.get("kind") in CHAT_KINDS}
        self._me_id, self._owner_id = me_id, owner_id
        self._display_name = str(me.get("display_name") or "")
        self._kinds = kinds
        self._names = {str(c["id"]): c["name"] for c in conversations
                       if isinstance(c, dict) and str(c.get("id") or "") in kinds
                       and isinstance(c.get("name"), str) and c["name"]}
        self._conversation_ids = tuple(kinds)

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
            if ws.close_code == WS_CLOSE_TOKEN_INVALID:
                # 토큰 값·사유 본문은 로그에 싣지 않는다(코드만).
                logger.warning("ohmyslack: websocket closed with code %d (token invalid); not reconnecting",
                               WS_CLOSE_TOKEN_INVALID)
                self._set_fatal_error("unauthorized", "ohmyslack bot token revoked (ws 1008)", retryable=False)
                await self._notify_fatal_error()
                return
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
                    self._set_fatal_error("unauthorized", "ohmyslack bot token rejected (401)", retryable=False)
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
                # 서버가 구독을 지웠다(hub replay 실패) → REST catch-up 후 참여 대화를 다시 구독한다(Codex r3 P1).
                # 캐시된 목록에 이미 나간 대화가 남지 않도록 먼저 /me를 다시 읽는다(BOT_CHANNEL_SPEC §5-8).
                await self._refresh_me()
                await self._catch_up(self._watermark)
                for cid in self._conversation_ids:
                    await ws.send_json({"type": "conversation.subscribe", "conversation_id": cid,
                                        "after_cursor": self._watermark})
                await self._flush_backlog()
            elif kind == "membership.changed":
                await self._on_membership(ws, str(frame.get("conversation_id") or ""), frame.get("state"))
            elif kind == "error" and frame.get("code") == "not_found" and frame.get("conversation_id"):
                self._forget_conversation(str(frame["conversation_id"]))  # 서버가 구독을 지웠다(멤버십 종료)
            elif kind == "error" and frame.get("code") == "cursor_expired":
                raise CursorExpired(410, "/ws")

    async def _on_membership(self, ws: aiohttp.ClientWebSocketResponse, cid: str, state: Any) -> None:
        """§5-8: joined → /me 재조회 후 그 대화만 현재 watermark로 구독. left → 맵·구독 목록에서 제거."""
        if not cid:
            return
        if state == "joined":
            await self._refresh_me()
            if cid in self._kinds:
                await ws.send_json({"type": "conversation.subscribe", "conversation_id": cid,
                                    "after_cursor": self._watermark})
        elif state == "left":
            self._forget_conversation(cid)

    def _forget_conversation(self, cid: str) -> None:
        # 이후 그 대화의 프레임·sync 변경은 "모르는 대화"로 무시된다. 남은 백로그 안내도 버린다.
        self._kinds = {k: v for k, v in self._kinds.items() if k != cid}
        self._names = {k: v for k, v in self._names.items() if k != cid}
        self._conversation_ids = tuple(self._kinds)
        self._backlog.pop(cid, None)

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
            if any(str(c.get("conversation_id") or "") not in self._kinds for c in changes):
                # sync는 현재 활성 참여 대화만 싣는다(sync/repo.ts) → 모르는 대화가 보이면 joined 프레임보다
                # 먼저 온 새 멤버십이다. 버리고 커서를 넘기면 첫 지시가 영구 누락되므로 /me를 먼저 다시 읽는다(Codex P2).
                await self._refresh_me()
            # 답글 변경 시 서버는 원문 projection도 함께 싣는다(sync/repo.ts:75-78) — 그 원문은 새 지시가 아니다.
            reply_roots = {str((c.get("message") or {}).get("thread_root_id") or "") for c in changes}
            for change in changes:
                m = change.get("message") or {}
                op = change.get("op") if change.get("op") in SYNC_OPS else None
                # op가 있으면 그것만으로 판정한다(답글에 동반된 원문은 서버가 `edit`로 싣는다). 없으면 기존 추론.
                aux_root = op is None and m.get("thread_root_id") is None and str(m.get("id") or "") in reply_roots
                await self._ingest(str(change.get("conversation_id") or ""), m, aux_root=aux_root, op=op)
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
        # 같은 페이지의 owner 멘션 루트도 봇 스레드로 센다(API 조회 없음 — 오차는 안내 숫자뿐, REPORT 명시).
        page_roots = frozenset(str(m.get("id") or "") for m in messages if m.get("thread_root_id") is None
                               and self._is_owner_instruction(m) and self._mentions_me(m))
        for m in messages:
            mid = str(m.get("id") or "")
            fresh = not self._dedup.is_duplicate(mid)
            created = _epoch(m.get("created_at")) or 0.0
            oldest = min(oldest, created)
            if prev is not None and fresh and self._is_owner_instruction(m) and self._passes_gate(cid, m, page_roots) \
                    and created >= prev.saved_at:
                self._backlog[cid] = self._backlog.get(cid, 0) + 1
        return oldest

    # ---------- inbound ----------
    def _is_owner_instruction(self, m: dict) -> bool:
        author = str(m.get("author_id") or "")
        return (bool(author) and author != self._me_id and author == self._owner_id
                and m.get("deleted_at") is None and m.get("body") is not None)

    def _mentions_me(self, m: dict) -> bool:
        mentions = m.get("mention_user_ids")
        return isinstance(mentions, list) and self._me_id in {str(x) for x in mentions}

    def _passes_gate(self, conversation_id: str, m: dict, page_roots: frozenset = frozenset()) -> bool:
        """대화 종류·멘션 게이팅(§5-2, 백로그 집계용 동기 판정): DM은 통과, 채널은 수정되지 않은 봇 멘션이거나
        알려진 봇 스레드(집합·같은 페이지 루트)의 비멘션 답글, 모르는 대화는 거부."""
        kind = self._kinds.get(conversation_id)
        if kind == "dm":
            return True
        if kind != "channel" or m.get("edited_at") is not None:
            return False
        if self._mentions_me(m):
            return True
        root = self._follow_candidate(m)
        return root is not None and (root in self._bot_threads or root in page_roots)

    def _follow_candidate(self, m: dict) -> Optional[str]:
        """멘션 없는 채널 답글이 봇 스레드 이어받기 후보면 루트 id. 수정본·다른 사용자 멘션(그 사람에게 한 말)은 제외."""
        root = str(m.get("thread_root_id") or "")
        if not root or m.get("edited_at") is not None or m.get("mention_user_ids"):
            return None
        return root

    def _mark_bot_thread(self, root: str) -> None:
        self._not_bot_threads.pop(root, None)
        self._bot_threads.pop(root, None)
        self._bot_threads[root] = None
        while len(self._bot_threads) > BOT_THREADS_MAX:
            del self._bot_threads[next(iter(self._bot_threads))]

    async def _follows_bot_thread(self, conversation_id: str, m: dict) -> bool:
        """봇 스레드(owner가 봇을 멘션해 시작한 스레드)의 owner 비멘션 답글인가(§10 Q5 변경 2026-11-13).

        집합에 없으면(재시작 등) 루트를 1회 조회해 작성자 == owner·봇 멘션이면 통과. 404·오류·타임아웃은 거부하고
        음성 결과와 함께 짧게 캐시한다. 로그엔 루트 ID·예외 종류만.
        """
        root = self._follow_candidate(m)
        if root is None:
            return False
        if root in self._bot_threads:
            return True
        now = self._clock()
        if self._not_bot_threads.get(root, 0.0) > now or not _is_uuid(root) or self._client is None:
            return False
        ok = False
        try:
            data = await asyncio.wait_for(self._client.get_replies(root), ROOT_LOOKUP_TIMEOUT_SECONDS)
            r = data.get("root") if isinstance(data, dict) else None
            ok = (isinstance(r, dict) and str(r.get("id") or "") == root
                  and str(r.get("conversation_id") or conversation_id) == conversation_id
                  and r.get("thread_root_id") is None and str(r.get("author_id") or "") == self._owner_id
                  and self._mentions_me(r))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — fail-closed
            logger.warning("ohmyslack: thread root %s lookup failed (%s)", root, type(exc).__name__)
        if ok:
            self._mark_bot_thread(root)
        else:
            self._not_bot_threads = {k: v for k, v in self._not_bot_threads.items() if v > now}
            self._not_bot_threads[root] = now + NOT_BOT_THREAD_TTL_SECONDS
        return ok

    async def _ingest(self, conversation_id: str, m: dict, *, aux_root: bool = False,
                      op: Optional[str] = None) -> None:
        # 순서(§5-7): owner 판정 → 대화 종류·멘션 게이팅 → dedupe → 15분 상한.
        mid = str(m.get("id") or "")
        if not mid or not conversation_id or not self._is_owner_instruction(m):
            return
        kind = self._kinds.get(conversation_id)
        if kind is None:
            return  # 모르는 대화는 기본 거부(§5-1, S8)
        if kind == "channel" and not self._mentions_me(m) and not await self._follows_bot_thread(conversation_id, m):
            # 게이팅 탈락: 실행·백로그 집계 없이 dedupe에만 기록한다. 봇 스레드의 owner 비멘션 답글은 통과(§10 Q5).
            if not self._dedup.is_duplicate(mid):
                self._remember(mid)
            return
        if self._dedup.is_duplicate(mid):
            return
        if aux_root:
            # 답글 변경에 동반된 원문 projection은 실행·집계 대상이 아니다(Codex r3 P2). 원문 생성 변경과
            # 구분할 수 없으므로 같은 페이지의 원문 생성은 다음 live/catch-up에서 다시 보지 않게 된다(REPORT §6).
            return
        # 채널은 op와 무관하게 수정된 글을 실행하지 않는다: sync는 현재 행을 실어 create 변경에도 수정으로 붙은
        # 멘션이 보일 수 있다(sync/repo.ts, §5-2 4항).
        if (op is not None and op != "create") or (op is None and m.get("edited_at") is not None) \
                or (kind == "channel" and m.get("edited_at") is not None):
            # 수정·삭제 변경은 새 지시로 실행하지 않는다(WS message.updated와 동일). op 없는 구 서버는 edited_at로 추론.
            self._remember(mid)
            return
        created = _epoch(m.get("created_at"))
        if created is None or self._clock() - created > BACKLOG_LIMIT_SECONDS:
            self._backlog[conversation_id] = self._backlog.get(conversation_id, 0) + 1
            self._remember(mid)
            return
        thread_id = str(m.get("thread_root_id") or mid)
        self._root_of[mid] = thread_id
        # 채널 이름은 project-router가 `proj-<slug>`로 프로젝트를 고르는 데 쓴다. DM·이름 없음이면 넘기지 않는다.
        chat_name = self._names.get(conversation_id) if kind == "channel" else None
        source = self.build_source(chat_id=conversation_id, chat_type=kind, user_id=str(m["author_id"]),
                                   thread_id=thread_id, message_id=mid,
                                   **({"chat_name": chat_name} if chat_name else {}))
        text = strip_mention_token(str(m["body"]), self._display_name) if kind == "channel" else str(m["body"])
        try:
            # 다운로드는 dedup 해제 보호 구간 안: 취소되면 discard 후 재연결 catch-up에서 다시 받는다.
            media_urls, media_types = await self._cache_inbound_images(m)
            event = MessageEvent(text=text, user_id=str(m["author_id"]), source=source, raw_message=m,
                                 message_id=mid, media_urls=media_urls, media_types=media_types,
                                 message_type=MessageType.PHOTO if media_urls else MessageType.TEXT)
            await self.handle_message(event)
        except BaseException:
            # 인계 실패: 중복 방지 등록을 풀고 커서도 전진시키지 않는다 → 재연결 catch-up에서 재전달.
            self._dedup.discard(mid)
            raise
        if kind == "channel":
            self._mark_bot_thread(thread_id)  # 이후 이 스레드의 owner 비멘션 답글은 같은 세션으로 이어진다
        self._remember(mid)

    async def _cache_inbound_images(self, m: dict) -> tuple[list[str], list[str]]:
        """사람 메시지의 이미지 첨부를 봇 토큰으로 받아 Hermes 이미지 캐시에 둔다. 실패한 첨부는 건너뛴다(텍스트는 전달).

        오디오 첨부는 아직 Hermes에 넘기지 않는다(남은 작업). 로그에는 첨부 ID·예외 종류만 싣는다.
        """
        from gateway.platforms.base import cache_image_from_bytes_async
        urls: list[str] = []
        types: list[str] = []
        attachments = m.get("attachments") or ()
        for att in list(attachments)[:ATTACHMENTS_PER_MESSAGE_MAX]:
            if not isinstance(att, dict):
                continue
            aid, mime = str(att.get("id") or ""), str(att.get("mime") or "")
            ext = INBOUND_IMAGE_EXT.get(mime)
            if ext is None or att.get("expired") or not _is_uuid(aid) or self._client is None:
                continue
            try:
                data = await self._client.download_attachment(aid)
                path = await cache_image_from_bytes_async(data, ext=ext)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 첨부 하나의 실패로 지시 전달을 막지 않는다
                logger.warning("ohmyslack: inbound attachment %s skipped (%s)", aid, type(exc).__name__)
                continue
            urls.append(path)
            types.append(mime)
        return urls, types

    def _remember(self, mid: str) -> None:
        self._recent = (self._recent + (mid,))[-RECENT_IDS_MAX:]
        self._save_cursor(self._watermark)

    def _save_cursor(self, change_id: int) -> None:
        self._watermark = max(self._watermark, int(change_id))
        self._cursor.save(CursorState(change_id=self._watermark, saved_at=self._clock(), recent_ids=self._recent))

    def _home_dm(self) -> Optional[str]:
        """홈 채널은 DM 고정(§5-5): 설정된 홈이 맵에서 dm이면 그것, 아니면 맵의 유일한 dm."""
        home = getattr(getattr(self.config, "home_channel", None), "chat_id", None)
        if home and self._kinds.get(str(home)) == "dm":
            return str(home)
        dms = [cid for cid, kind in self._kinds.items() if kind == "dm"]
        return dms[0] if len(dms) == 1 else None

    async def _flush_backlog(self) -> None:
        for cid in list(self._backlog):
            n = self._backlog.pop(cid, 0)  # await 전에 꺼내 동시 flush의 중복 게시를 막는다
            if n <= 0:
                continue
            target, text = cid, BACKLOG_NOTICE.format(n=n)
            if self._kinds.get(cid) != "dm":
                # 채널 최상위에는 쓰지 않는다 → 홈 DM에 대화 ID를 붙여 1회(§5-7).
                target, text = self._home_dm(), f"{text} ({cid})"
                if target is None:
                    logger.warning("ohmyslack: no home DM for a channel backlog notice; keeping it")
                    self._backlog[cid] = self._backlog.get(cid, 0) + n
                    continue
            posted = False
            try:
                posted = (await self.send(target, text)).success
            finally:
                if not posted:  # 실패·예외·취소 모두 되돌려 다음 flush(재연결·구독 ACK)에서 다시 보낸다(Codex r4 P2)
                    self._backlog[cid] = self._backlog.get(cid, 0) + n

    # ---------- outbound ----------
    def _thread_root(self, reply_to: Optional[str], metadata: Optional[dict]) -> Optional[str]:
        meta_thread = metadata.get("thread_id") if isinstance(metadata, dict) else None
        if meta_thread:
            return self._root_of.get(str(meta_thread), str(meta_thread))
        if reply_to:
            return self._root_of.get(str(reply_to), str(reply_to))
        return None

    def _refuse_channel_top_level(self, chat_id: str, root: Optional[str]) -> Optional[SendResult]:
        """채널에서는 스레드 답글로만 쓴다(§5-6). 루트를 모르면 보내지 않고 로그만(본문 미기록).

        fail-closed(F-3): `/me`에서 확인된 dm만 그대로 보낸다. 모르는 대화(맵에 없음·이미 나감)는 루트가 있어도 거부한다.
        """
        kind = self._kinds.get(str(chat_id))
        if kind == "dm" or (kind == "channel" and root is not None):
            return None
        if kind == "channel":
            logger.warning("ohmyslack: refusing top-level post to a channel (no thread root)")
            return SendResult(success=False, error="ohmyslack: channel posts must be thread replies",
                              retryable=False, error_kind="forbidden")
        logger.warning("ohmyslack: refusing post to an unknown conversation")
        return SendResult(success=False, error="ohmyslack: unknown conversation",
                          retryable=False, error_kind="forbidden")

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="ohmyslack: not connected", retryable=True, error_kind="transient")
        root = self._thread_root(reply_to, metadata)
        refused = self._refuse_channel_top_level(chat_id, root)
        if refused is not None:
            return refused
        ids: list[str] = []
        chunks = self.truncate_message(content or "", self.MAX_MESSAGE_LENGTH)
        try:
            for chunk in chunks:
                res = await self._client.post_message(str(chat_id), chunk, thread_root_id=root)
                ids.append(str((res.get("message") or {}).get("id") or ""))
        except BotAuthError:
            return SendResult(success=False, error="ohmyslack: unauthorized", error_kind="forbidden")
        except BotApiError as exc:
            limited = exc.status == 429
            return self._failed_send(ids, f"ohmyslack: HTTP {exc.status}", retryable=limited, total=len(chunks),
                                     retry_after=exc.retry_after, kind="rate_limited" if limited else "unknown")
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return self._failed_send(ids, f"ohmyslack: {type(exc).__name__}", retryable=True, kind="transient",
                                     total=len(chunks))
        for mid in ids:
            if root:
                self._root_of[mid] = root
        return SendResult(success=True, message_id=ids[-1] if ids else None,
                          continuation_message_ids=tuple(ids) if len(ids) > 1 else ())

    def _send_retry_is_final(self, result: SendResult) -> bool:
        # 부분 게시는 남은 청크만 이어 보낼 수 없으므로(_resume_partial_send 미구현) 재시도 대기 없이 그대로 반환.
        return self._is_partial_delivery(result)

    @staticmethod
    def _failed_send(ids: list[str], error: str, *, retryable: bool, kind: str, total: int,
                     retry_after: Optional[float] = None) -> SendResult:
        if ids:
            # 일부 청크가 이미 게시됨: base 계약 `raw_response["partial_overflow"]`(base.py `_is_partial_delivery`)로
            # 알려 `_send_with_retry`의 재시도·plain-text fallback·delivery 재전송이 앞 청크를 다시 올리지 않게 한다.
            return SendResult(success=False, error=f"{error} (partial: {len(ids)} chunk(s) posted)",
                              retryable=False, error_kind=kind, continuation_message_ids=tuple(ids),
                              raw_response={"partial_overflow": True, "delivered_chunks": len(ids),
                                            "total_chunks": total, "partial_message_ids": list(ids)})
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
                                   reply_to: Optional[str], metadata: Optional[dict], *,
                                   reason: str = "is not supported yet") -> SendResult:
        # 경로·캡션·토큰은 로그에 남기지 않는다(reason은 고정 문구만).
        logger.warning("ohmyslack: %s %s; sending text fallback", method, reason)
        text = f"{caption}\n{ATTACHMENT_FALLBACK}" if caption else ATTACHMENT_FALLBACK
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    async def _send_attachment(self, method: str, allowed: dict[str, str], chat_id: str, path: Any,
                               caption: Optional[str], reply_to: Optional[str], metadata: Optional[dict],
                               declared_mime: Optional[str]) -> SendResult:
        """업로드 → `attachment_ids`로 메시지 생성(본문 = caption, 없으면 파일명).

        업로드 전·업로드 실패는 텍스트 대체. 업로드 성공 뒤 메시지 생성 실패는 대체 게시하지 않고 실패만 돌려준다
        (연결 오류면 이미 생성됐을 수 있어 중복이 된다). 결속되지 못한 첨부는 서버가 1시간 뒤 정리한다.
        """
        if self._client is None:
            return SendResult(success=False, error="ohmyslack: not connected", retryable=True, error_kind="transient")
        refused = self._refuse_channel_top_level(chat_id, self._thread_root(reply_to, metadata))
        if refused is not None:
            return refused  # 업로드 전에 막는다(대체 텍스트도 채널 최상위가 되므로 보내지 않음)
        loaded, _reason = await _read_off_loop(path, allowed, declared_mime)
        if loaded is None:
            return await self._attachment_fallback(method, chat_id, caption, reply_to, metadata,
                                                   reason="file rejected (type, size or not a regular file)")
        data, mime, name = loaded
        try:
            uploaded = await self._client.upload_attachment(str(chat_id), data, mime)
        except BotAuthError:
            return SendResult(success=False, error="ohmyslack: unauthorized", error_kind="forbidden")
        except (BotApiError, aiohttp.ClientError, asyncio.TimeoutError) as exc:
            logger.warning("ohmyslack: %s upload failed (%s)", method,
                           exc.status if isinstance(exc, BotApiError) else type(exc).__name__)
            return await self._attachment_fallback(method, chat_id, caption, reply_to, metadata,
                                                   reason="upload failed")
        attachment_id = str(uploaded.get("attachment_id") or "")
        if not _is_uuid(attachment_id):
            return await self._attachment_fallback(method, chat_id, caption, reply_to, metadata,
                                                   reason="upload response invalid")
        root = self._thread_root(reply_to, metadata)
        chunks = self.truncate_message(caption or name, self.MAX_MESSAGE_LENGTH) or [name]
        ids: list[str] = []
        try:
            for i, chunk in enumerate(chunks):
                res = await self._client.post_message(str(chat_id), chunk, thread_root_id=root,
                                                      attachment_ids=[attachment_id] if i == 0 else None)
                ids.append(str((res.get("message") or {}).get("id") or ""))
        except BotAuthError:
            return SendResult(success=False, error="ohmyslack: unauthorized", error_kind="forbidden")
        except BotApiError as exc:
            limited = exc.status == 429
            return self._failed_send(ids, f"ohmyslack: HTTP {exc.status}", retryable=False, total=len(chunks),
                                     retry_after=exc.retry_after, kind="rate_limited" if limited else "unknown")
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return self._failed_send(ids, f"ohmyslack: {type(exc).__name__}", retryable=False, kind="transient",
                                     total=len(chunks))
        for mid in ids:
            if root:
                self._root_of[mid] = root
        return SendResult(success=True, message_id=ids[0] if ids else None,
                          continuation_message_ids=tuple(ids) if len(ids) > 1 else ())

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_attachment("send_voice", VOICE_TYPES, chat_id, audio_path, caption, reply_to,
                                           metadata, kwargs.get("mime_type"))

    async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None,
                            metadata=None, **kwargs):
        return await self._attachment_fallback("send_document", chat_id, caption, reply_to, metadata)

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_attachment("send_image_file", IMAGE_TYPES, chat_id, image_path, caption, reply_to,
                                           metadata, kwargs.get("mime_type"))

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._attachment_fallback("send_video", chat_id, caption, reply_to, metadata)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        kind = self._kinds.get(str(chat_id)) or "unknown"  # 모르는 대화를 dm으로 보지 않는다(F-3)
        name = "Jarvis" if kind == "dm" else self._names.get(str(chat_id)) or str(chat_id)
        return {"name": name, "type": kind, "chat_id": str(chat_id)}


STANDALONE_TYPES = {**VOICE_TYPES, **IMAGE_TYPES}


def _media_path(descriptor: Any) -> Any:
    """Hermes `media_files` 원소: `(path, is_voice)` 튜플(base.extract_media) 또는 경로 문자열."""
    if isinstance(descriptor, (list, tuple)):
        return descriptor[0] if descriptor else None
    return descriptor


# standalone 호출 계약: 플러그인은 `max_message_length=0`으로 등록해 Hermes가 원문 전체·첨부 전체를 sender **1회** 호출에
# 싣는다(Hermes `tools/send_message_tool.py` `_platform_max_length`·`_send_to_platform`). 그래서 아래 deadline 하나가
# 전송 전체(`/me` 1회·파일 읽기·업로드·내부 청크 게시와 그 재시도)를 덮는다.
# standalone 전송 전체 deadline(초, 호출 시작 기준). Hermes 바깥 상한은 정상 분기 60초(`cron.standalone_send_timeout_seconds`
# 기본값 — 어댑터는 실제 설정값을 알 수 없어 기본값을 가정한다, README)지만, 실행 중인 루프 안에서 불리는 폴백 분기는
# 30초(`cron/scheduler_delivery.py` `_standalone_send`의 `.result(timeout=30)`)라 그보다 5초 짧게 둔다 — 폴백이 먼저 끊고
# 재전달 큐에 넣는 동안 이쪽 전송이 성공해 이중 게시되는 것을 막는다. 대상은 루프백 봇 리스너라 정상 경로는 1초 미만이다.
STANDALONE_TOTAL_DEADLINE_S = 25.0
# 텍스트 게시 몫: 업로드 예산은 deadline까지 남은 시간에서 이만큼 먼저 떼고 계산한다(텍스트가 첨부보다 우선).
STANDALONE_TEXT_RESERVE_S = 8.0
# standalone 업로드 전체가 쓰는 공유 시간 예산 상한(초). 실제 예산은 min(이 값, 남은 시간 − 텍스트 몫).
STANDALONE_UPLOAD_BUDGET_S = 15.0


# 단조 시계 — 호출 시점에 모듈 속성에서 읽는다(Hermes는 sender에 `clock=`을 넘길 수 없어, 실제 진입점 테스트가
# 이 속성을 바꿔 주입한다. `time.monotonic` 전역 교체는 asyncio 루프 시계까지 바꾸므로 쓰지 않는다).
_clock: Callable[[], float] = time.monotonic


class _DeadlineExceeded(Exception):
    """standalone 전체 deadline 소진(Hermes 취소 전에 send_error로 끝내기 위한 내부 신호)."""


async def _within(aw: Any, left: Callable[[], float]) -> Any:
    """`aw`를 deadline까지 남은 시간(`left()`, 초)으로 제한한다. 남은 시간이 없거나 그 때문에 끊기면 _DeadlineExceeded."""
    if left() <= 0:
        aw.close()
        raise _DeadlineExceeded
    timeout = asyncio.timeout(left())
    try:
        async with timeout:
            return await aw
    except TimeoutError:
        if timeout.expired():
            raise _DeadlineExceeded from None
        raise


async def _upload_one(client: BotClient, chat_id: str, data: bytes, mime: str,
                      remaining: Callable[[], float]) -> tuple[Optional[str], str]:
    """업로드 1건 → (첨부 ID, 실패 사유). 남은 예산으로 감싸고, 예산보다 긴 재시도 대기는 하지 않는다."""
    try:
        uploaded = await asyncio.wait_for(client.upload_attachment(chat_id, data, mime, remaining=remaining),
                                          timeout=max(remaining(), 0.0))
    except (BotApiError, aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.warning("ohmyslack: standalone upload failed (%s)",
                       exc.status if isinstance(exc, BotApiError) else type(exc).__name__)
        timed_out = isinstance(exc, asyncio.TimeoutError) and remaining() <= 0
        return None, "budget_exceeded" if timed_out else "upload_failed"
    attachment_id = str(uploaded.get("attachment_id") or "")
    return (attachment_id, "") if _is_uuid(attachment_id) else (None, "upload_failed")


async def _upload_standalone_media(client: BotClient, chat_id: str, media_files: Any, *,
                                   budget: Optional[float] = None,
                                   clock: Optional[Callable[[], float]] = None,
                                   ) -> tuple[list[str], list[str], list[str]]:
    """standalone 첨부 업로드 → (첨부 ID, 파일명, warnings). 실패는 파일마다 `"<basename>: <사유>"` 한 줄.

    판정·상한은 라이브 `_send_attachment`와 같다(read_attachment_file, 음성·이미지 허용목록, 10 MiB).
    시도는 지원 형식 앞 ATTACHMENTS_PER_MESSAGE_MAX개까지(성공 여부 무관), 전체는 `budget`초(단조 `clock`) 안에서만 —
    예산이 다 되면 남은 파일은 업로드하지 않고 `budget_exceeded`. 경로 전체·본문·토큰은 warnings·로그에 남기지 않는다.
    """
    clock = clock or _clock
    deadline = clock() + (STANDALONE_UPLOAD_BUDGET_S if budget is None else budget)

    def remaining() -> float:
        return deadline - clock()
    ids: list[str] = []
    names: list[str] = []
    warnings: list[str] = []
    attempts = 0
    for descriptor in media_files or ():
        path = _media_path(descriptor)
        try:
            name = os.path.basename(os.fspath(path))
        except TypeError:
            warnings.append("(invalid): rejected")
            continue
        if STANDALONE_TYPES.get(os.path.splitext(name)[1].lower()) is None:
            warnings.append(f"{name}: unsupported_type")
            continue
        attempts += 1
        if attempts > ATTACHMENTS_PER_MESSAGE_MAX:
            warnings.append(f"{name}: too_many")
            continue
        if remaining() <= 0:
            warnings.append(f"{name}: budget_exceeded")
            continue
        try:  # 검사·읽기(daemon 스레드 1회)도 예산 안에서만 — 멈춘 파일 시스템이 전송 전체를 붙잡지 않게
            loaded, reason = await asyncio.wait_for(_read_off_loop(path, STANDALONE_TYPES),
                                                    timeout=max(remaining(), 0.0))
        except asyncio.TimeoutError:
            warnings.append(f"{name}: budget_exceeded")
            continue
        if loaded is None:
            warnings.append(f"{name}: {reason or 'rejected'}")
            continue
        data, mime, _ = loaded
        attachment_id, reason = await _upload_one(client, str(chat_id), data, mime, remaining)
        if attachment_id is None:
            warnings.append(f"{name}: {reason}")
            continue
        ids.append(attachment_id)
        names.append(name)
    return ids, names, warnings


async def standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                          media_files=None, force_document: bool = False,
                          session_factory: Callable[[], aiohttp.ClientSession] = new_session,
                          upload_budget: Optional[float] = None,
                          clock: Optional[Callable[[], float]] = None) -> dict:
    """게이트웨이 밖 cron 전달: owner DM(홈 채널)에 최상위 메시지. `thread_id`·`force_document`는 쓰지 않는다.

    단일 호출 계약: `max_message_length=0` 등록으로 Hermes는 원문 전체·첨부 전체를 이 함수 **1회** 호출에 넘긴다 —
    청크 분할(MAX_MESSAGE_LENGTH)·첨부 결속은 여기서만 정한다.
    홈 채널은 DM 고정(BOT_CHANNEL_SPEC §5-5): `/me`에서 대상이 dm이 아니면(채널·모르는 대화) 업로드도 하지 않는다.
    첨부(ADR-002 1a): 음성·이미지는 업로드해 첫 청크에 결속, 지원 밖·없는 파일·상한 초과·업로드 실패·시간 예산 초과는
    파일마다 `warnings`에 싣고 텍스트는 보낸다.
    전체는 시작 시각부터 STANDALONE_TOTAL_DEADLINE_S초(단조 시계) 안에서만 — Hermes 바깥 상한에 취소되면
    텍스트·warnings가 모두 사라지므로. `/me`·게시(재시도 대기 포함)는 남은 시간으로 제한하고, 업로드는
    min(`upload_budget`, 남은 시간 − STANDALONE_TEXT_RESERVE_S)초만 쓴다.
    결과: 청크를 하나도 못 올렸으면 send_error(모인 첨부 warnings를 메시지에 덧붙인다 — Hermes는 실패 시 `error`만
    남기고, 아무것도 안 나갔으므로 재전달 큐가 안전하다). 청크 k개(≥1)를 올린 뒤 실패·deadline 초과면 `success` +
    `warnings`의 `text: partial_delivery <k>/<n>` — error로 돌려주면 Hermes 재전달 큐가 원문 전체를 다시 보내 앞 청크가
    중복되므로, 중복 대신 보이는 꼬리 유실을 택한다(첫 청크 = 첨부 결속 청크이므로 첨부는 전달됨).
    """
    from gateway.platforms._shared import send_error
    extra = getattr(pconfig, "extra", None) or {}
    token = (getattr(pconfig, "token", None) or get_scoped_secret(TOKEN_ENV, "") or "").strip()
    if not token or not chat_id:
        return send_error("ohmyslack standalone send: OHMYSLACK_BOT_TOKEN and home channel must be set")
    try:
        base = resolve_bot_url(extra)
    except ValueError as exc:
        return send_error(f"ohmyslack standalone send: {exc}")
    clock = clock or _clock  # 기본값은 호출 시점의 모듈 속성(진입점 테스트 주입 훅)
    upload_budget = STANDALONE_UPLOAD_BUDGET_S if upload_budget is None else upload_budget
    started = clock()

    def left() -> float:
        return started + STANDALONE_TOTAL_DEADLINE_S - clock()

    record = _SendRecord()
    async with session_factory() as session:
        client = BotClient(base, token, session)
        try:
            me = await _within(client.get_me(), left)
            kinds = {str(c.get("id")): c.get("kind") for c in me.get("conversations") or () if isinstance(c, dict)}
            if kinds.get(str(chat_id)) != "dm":
                return send_error("ohmyslack standalone send: home channel must be the owner DM")
            me_id = str(me.get("id") or "")
            budget = min(upload_budget, left() - STANDALONE_TEXT_RESERVE_S)
            record.attachment_ids, names, record.warnings = await _upload_standalone_media(
                client, str(chat_id), media_files, budget=budget, clock=clock)
            text = message or (names[0] if names else "")
            chunks = BasePlatformAdapter.truncate_message(text, OhmySlackAdapter.MAX_MESSAGE_LENGTH)
            record.chunks = [_ChunkRecord(key=str(uuid.uuid4())) for _ in chunks]  # 키는 게시 전에 청크마다 하나
            for i, (chunk, rec) in enumerate(zip(chunks, record.chunks)):
                # 청크 0을 한 번이라도 시도했으면 재업로드하지 않는다 — 첨부 ID는 루프 전에 한 번 정해진다.
                attach = record.attachment_ids if i == 0 and record.attachment_ids else None
                if not await _post_chunk(client, str(chat_id), chunk, rec, attach, me_id, left):
                    break  # 확인 안 된 청크 뒤로는 보내지 않는다(순서 보장 + 중복 범위 축소)
        except _DeadlineExceeded:
            record.reason = "deadline_exceeded"
        except BotApiError as exc:
            record.reason = f"HTTP {exc.status}"
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            record.reason = type(exc).__name__
    return _standalone_result(record)


@dataclass
class _ChunkRecord:
    """청크 하나의 전달 기록(설계 r4 §Q1-4). state: pending → attempted → confirmed|rejected|conflict|ambiguous."""

    key: str
    state: str = "pending"
    attempts: list[Attempt] = field(default_factory=list)
    message_id: Optional[str] = None  # 검증된 UUID(정상 ACK 또는 확인 GET found)에서만
    reason: str = ""  # rejected 사유(`HTTP <n>` 등)


@dataclass
class _SendRecord:
    """standalone 호출 하나의 기록 — 반환은 `_standalone_result`에서만 조립한다."""

    chunks: list[_ChunkRecord] = field(default_factory=list)
    attachment_ids: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    reason: str = ""  # 청크 시도 밖의 실패(`/me`·deadline 등)


def _settle(rec: _ChunkRecord, message_id: Optional[str], cut: bool) -> None:
    """시도 기록 → 종결 상태. 409는 앞 모호성과 무관하게 conflict, 앞 모호성은 뒤 4xx로 지우지 않는다."""
    may_have_committed = any(a.may_have_committed for a in rec.attempts)
    last = rec.attempts[-1] if rec.attempts else None
    if message_id is not None:
        rec.state, rec.message_id = "confirmed", message_id
    elif last is not None and last.outcome == "conflict":
        rec.state = "conflict"
    elif may_have_committed or cut:
        rec.state = "ambiguous"
    else:
        rec.state = "rejected"
        rec.reason = f"HTTP {last.status}" if last is not None and last.status else "not_sent"


async def _post_chunk(client: BotClient, chat_id: str, body: str, rec: _ChunkRecord,
                      attachment_ids: Optional[list[str]], me_id: str, left: Callable[[], float]) -> bool:
    """청크 1개 게시 → 확인됐으면 True. 모호하면 봇 이력 GET 1회로 확인하고, 그래도 모르면 ambiguous로 남긴다."""
    if left() <= 0:
        raise _DeadlineExceeded  # 보내지 않은 청크는 pending 그대로(attempted 아님)
    rec.state = "attempted"
    message_id, cut = None, False
    try:
        message_id = await _within(client.post_message(
            chat_id, body, attachment_ids=attachment_ids, remaining=left, client_message_id=rec.key,
            observe=rec.attempts.append, author_id=me_id), left)
    except _DeadlineExceeded:
        cut = True  # 시도 중 끊김 — 서버 커밋 여부 미상
    _settle(rec, message_id, cut)
    if rec.state == "ambiguous":
        check, found_id = await client.history_contains(chat_id, rec.key, author_id=me_id, timeout=left())
        if check == "found":
            rec.state, rec.message_id = "confirmed", found_id
        else:
            logger.warning("ohmyslack: standalone confirm %s", check)
    return rec.state == "confirmed"


def _standalone_result(record: _SendRecord) -> dict:
    """기록 → sender 결과(설계 r4 §Q1-7 반환표). 청크 0 불명·충돌은 성공으로 숨기지 않는다."""
    from gateway.platforms._shared import send_error
    warnings = list(record.warnings)
    n = len(record.chunks)
    k = next((i for i, c in enumerate(record.chunks) if c.state != "confirmed"), n)
    if k == 0:
        suffix = f"; warnings: {', '.join(warnings)}" if warnings else ""
        first = record.chunks[0] if record.chunks else None
        if first is not None and first.state == "ambiguous":
            logger.warning("ohmyslack: standalone delivery_unknown chunk 1/%d", n)
            reason = f"delivery_unknown chunk 1/{n}"
        elif first is not None and first.state == "conflict":
            logger.warning("ohmyslack: standalone idempotency_conflict chunk 1/%d", n)
            reason = f"idempotency_conflict chunk 1/{n}"
        else:
            reason = (first.reason if first is not None else "") or record.reason
        return send_error(f"ohmyslack standalone send: {reason}{suffix}")
    if k < n:  # 부분 게시: 재전달(전체 재전송)을 타지 않게 성공 + 보이는 경고
        state = record.chunks[k].state
        logger.warning("ohmyslack: standalone send partial (%d/%d chunks, %s)", k, n, state)
        warnings.append(f"text: partial_delivery {k}/{n}")
        if state == "ambiguous":
            logger.warning("ohmyslack: standalone delivery_unknown chunk %d/%d", k + 1, n)
            warnings.append(f"text: delivery_unknown chunk {k + 1}")
        elif state == "conflict":
            logger.warning("ohmyslack: standalone idempotency_conflict chunk %d/%d", k + 1, n)
            warnings.append(f"text: idempotency_conflict chunk {k + 1}")
    out: dict[str, Any] = {"success": True, "message_id": record.chunks[k - 1].message_id}
    if warnings:
        out["warnings"] = warnings
    elif record.attachment_ids:
        out["media_delivered"] = True  # Hermes generic 경로가 "MEDIA attachments were omitted"를 붙이지 않게
    return out
