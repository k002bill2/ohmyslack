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
import json
import sys
import threading
import time
import types
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

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
ATTACHMENT_UNBOUND_TTL_S = 60 * 60  # packages/shared/src/attachments.ts:11 ATTACHMENT_UNBOUND_TTL_MS = 60 * 60 * 1000


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path, monkeypatch):
    # Hermes 홈을 tmp로 격리(실제 ~/.hermes 읽기·쓰기 방지), 플러그인 env 비움.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    for name in ("OHMYSLACK_BOT_TOKEN", "OHMYSLACK_BOT_URL", "OHMYSLACK_BOT_PORT", "OHMYSLACK_HOME_CHANNEL",
                 "OHMYSLACK_POST_CHANNELS"):
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


class _Disconnect(Exception):
    """핸들러가 응답 없이 연결을 끊게 하는 표지(아래 미들웨어가 transport 를 닫는다)."""


@web.middleware
async def _disconnect_middleware(request, handler):
    try:
        return await handler(request)
    except _Disconnect:
        if request.transport is not None:
            request.transport.close()
        raise asyncio.CancelledError() from None


class _ShortBody:
    """Content-Length 는 전체 길이로 선언하고 절반만 보낸 뒤 연결을 닫는다 → 클라이언트 ClientPayloadError."""

    def __init__(self, raw: bytes, status: int) -> None:
        self.raw, self.status = raw, status

    async def send(self, request: web.Request):
        resp = web.StreamResponse(status=self.status, headers={"Content-Type": "application/json"})
        resp.content_length = len(self.raw)
        await resp.prepare(request)
        await resp.write(self.raw[: len(self.raw) // 2])
        raise _Disconnect()


class _BadStatusLine(_ShortBody):
    """HTTP 응답 대신 잘못된 상태줄을 소켓에 직접 쓰고 닫는다 → 클라이언트 응답 시작 단계 파싱 실패.

    aiohttp `ClientResponse.start`가 `HttpProcessingError`를 일반 `ClientResponseError`로 바꾼다
    (`.venv/.../aiohttp/client_reqrep.py:744-753`) — 상태 응답 객체는 호출자에게 오지 않는다.
    """

    async def send(self, request: web.Request):
        if request.transport is not None:
            request.transport.write(b"HTTP/1.1 2x1 Created\r\nContent-Length: 0\r\n\r\n")
        raise _Disconnect()


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
        # ---- 단계 2(설계 r4 §4): 멱등·결속·이력·장애 주입. 서버 대조 근거는 레인 REPORT.
        self.idem: dict[tuple[str, str, str], dict] = {}  # (cid, author, client_message_id) → 저장 시 payload 정규형 + message id
        # 첨부 메타(S/attachments/repo.ts bindInTx): id → {conversation_id, uploader_id, created_at, message_id, deleted}
        self.attachments: dict[str, dict] = {}
        self.attachment_ttl_s = ATTACHMENT_UNBOUND_TTL_S  # 미결속 유예(shared ATTACHMENT_UNBOUND_TTL_MS)
        self.clock = time.time  # 첨부 created_at·유예 판정 시계(주입 가능)
        # 참여자·비활성 사용자(S/messages/repo.ts MENTION_FILTER_SQL). 목록에 없는 대화는 DM 기본값.
        self.members: dict[str, set[str]] = {DM_ID: {BOT_ID, OWNER_ID}, CHANNEL_ID: {BOT_ID, OWNER_ID, OTHER_ID}}
        self.inactive_user_ids: set[str] = set()
        # 참여자 가입 시각(cm.joined_at). 기록 없으면 아주 오래전(0.0) 가입. 퇴장(left_at)은 members 에서 제거로 모델링.
        self.joined_at: dict[tuple[str, str], float] = {}
        self.hidden_message_ids: set[str] = set()  # 봇에게 안 보이는 메시지(참여 전 시작 스레드 등, S/bots/routes.ts §4-5)
        # 커밋(저장 또는 replay 판정) 뒤에 적용 — 연결 유실과 본문 파싱 실패는 별도 스위치.
        self.post_disconnect_after_commit = 0  # 다음 N회: 응답 없이 연결 끊기(ServerDisconnectedError)
        # "json_truncated"·"json_invalid" = 완전한 응답의 잘린/깨진 JSON(파싱 실패), 상태 200/201 그대로.
        # "short_body" = Content-Length 보다 적게 보내고 연결 닫기(수신 단계 ClientPayloadError).
        # "bad_status_line" = 잘못된 상태줄 원시 쓰기 후 닫기(응답 시작 단계 일반 ClientResponseError).
        self.post_body_fault_after_commit: list[str] = []
        # /me·업로드 2xx 응답 본문 이상: "json_invalid"(깨진 JSON) | "empty"(빈 본문 → aiohttp json() None).
        # 업로드는 첨부 저장 뒤에 적용(실제 서버도 커밋 후 응답).
        self.me_body_fault: list[str] = []
        self.upload_body_fault: list[str] = []
        self.post_redirect_after_commit: list[int] = []  # 3xx 상태(Location = /me)
        self.history_status: list[int] = []  # 이력 GET 강제 상태(예: [401], [403])
        self.history_disconnect = 0  # 이력 GET 다음 N회 연결 끊기
        self.history_delay = 0.0  # 이력 GET 응답 전 실제 대기(초)
        self.history_body_fault: list[str] = []  # 이력 GET "json_truncated" | "json_invalid" | "short_body"
        self.history_calls = 0
        # 이력 응답 끝에 덧붙일 항목을 만드는 함수(실제 서버는 원문만 내지만, 클라이언트 쪽 작성자·최상위 조건 방어 검사용)
        self.history_extra: Optional[Callable[[], list[dict]]] = None
        self.base = ""
        self._runner: Optional[web.AppRunner] = None

    # ---- state helpers ----
    def add(self, message: dict, conv: str = DM_ID, op: Optional[str] = None) -> int:
        self.next_change += 1
        self.changes.append((self.next_change, conv, message))
        if op is not None:
            self.ops[self.next_change] = op
        return self.next_change

    def current(self, mid: str) -> Optional[dict]:
        """메시지의 현재 상태(같은 id의 마지막 변경)."""
        mid = mid.lower()  # UUID 소문자 정규화(S/messages/repo.ts:183-190)
        return next((m for _c, _conv, m in reversed(self.changes) if m.get("id", "").lower() == mid), None)

    def tombstone(self, mid: str) -> int:
        """삭제: 본문 NULL·deleted_at 설정, client_message_id 등 키는 보존(서버 delete 와 같은 모양)."""
        base = self.current(mid)
        assert base is not None, mid
        dead = {**base, "body": None, "deleted_at": iso(1000.0), "attachments": []}
        conv = next(conv for _c, conv, m in self.changes if m.get("id") == mid)
        return self.add(dead, conv, op="delete")

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
        if self.me_body_fault:
            return self._broken(self.me_body_fault.pop(0), {}, 200)
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
        cid = request.match_info["cid"]
        # 루트 가시성(S/bots/routes.ts:190-208 threadRootGuard, :314) — rateGuard·replay 판정보다 먼저 404.
        root = payload.get("thread_root_id")
        if root is not None and not self._visible_in(cid, root):
            self.posts.append({**payload, "_status": 404, "conversation_id": cid})
            return web.json_response({"error": "not_found"}, status=404)
        ok_so_far = sum(1 for p in self.posts if p["_status"] == 200)
        if self.post_429 > 0 or (self.ok_posts_before_429 is not None and ok_so_far >= self.ok_posts_before_429):
            self.post_429 = max(0, self.post_429 - 1)
            self.posts.append({**payload, "_status": 429})
            return web.json_response({"error": "rate_limited"}, status=429, headers={"Retry-After": "1"})
        body = payload.get("body")
        if not isinstance(body, str) or not body.strip():  # shared/messages.ts:15-18 bodySchema → S/messages/routes.ts:35
            self.posts.append({**payload, "_status": 400, "conversation_id": cid})
            return web.json_response({"error": "invalid_request"}, status=400)
        resp = self._store_or_replay(cid, payload)
        return await resp.send(request) if isinstance(resp, _ShortBody) else resp

    def _first_conv(self, mid: str) -> Optional[str]:
        mid = mid.lower()  # S/bots/routes.ts:201-203, S/messages/repo.ts:183-190 — UUID 는 소문자 정규화 비교
        return next((conv for _c, conv, m in self.changes if m["id"].lower() == mid), None)

    def _visible_in(self, cid: str, mid: str) -> bool:
        """봇 가시성: 이 대화에 저장된 메시지이고 숨김 목록에 없다(없음·숨김·다른 대화 모두 같은 404)."""
        return self._first_conv(mid) == cid and mid.lower() not in {h.lower() for h in self.hidden_message_ids}

    def join(self, cid: str, user: str, at: Optional[float] = None) -> None:
        """참여자 가입(joined_at = at 또는 지금)."""
        self.members.setdefault(cid, {BOT_ID, OWNER_ID}).add(user)
        self.joined_at[(cid, user)] = self.clock() if at is None else at

    def leave(self, cid: str, user: str) -> None:
        """참여자 퇴장(left_at 설정 = 현재 참여자 집합에서 제거)."""
        self.members.setdefault(cid, {BOT_ID, OWNER_ID}).discard(user)

    def _members(self, cid: str) -> set[str]:
        return self.members.get(cid, {BOT_ID, OWNER_ID})

    def _eligible(self, cid: str, author: str) -> set[str]:
        """멘션 대상 자격(MENTION_FILTER_SQL): 활성 참여자이고 작성자 본인이 아님."""
        return {u for u in self._members(cid) if u != author and u not in self.inactive_user_ids}

    @staticmethod
    def _norm(payload: dict) -> dict:
        """멱등 비교 정규형: thread_root(원문 그대로)·첨부 ID 집합(소문자)·본문·멘션 요청 집합.

        replay 의 thread_root 비교는 요청 원문 문자열과 DB 저장값(소문자 UUID)의 직접 비교다(S/messages/routes.ts:110-117,
        S/messages/repo.ts:171) — 가시성·조회만 소문자 정규화하고 비교는 정규화하지 않는다(저장 쪽은 `_store_or_replay`).
        """
        return {"thread_root_id": payload.get("thread_root_id"),
                "attachment_ids": sorted({a.lower() for a in payload.get("attachment_ids") or []}),
                "body": payload.get("body"), "mentions": sorted(set(payload.get("mention_user_ids") or []))}

    def _same_mentions(self, prior: dict, cid: str, requested: list[str]) -> bool:
        """S/messages/repo.ts:150-161 sameMentions: 저장 ⊆ 요청이고, 요청에만 있는 ID 중 **재요청 당시**
        left_at IS NULL·status='active'·작성자 아님·joined_at <= 메시지 생성 시각인 사람이 없어야 같은 요청."""
        req = set(requested)
        if not set(prior["stored_mentions"]) <= req:
            return False
        extra = req - set(prior["stored_mentions"])
        return not {u for u in extra & self._eligible(cid, BOT_ID)
                    if self.joined_at.get((cid, u), 0.0) <= prior["created_at"]}

    def seed_attachment(self, *, conv: str = DM_ID, uploader: str = BOT_ID, age: float = 0.0,
                        deleted: bool = False) -> str:
        """HTTP 업로드를 거치지 않은 첨부 메타(다른 업로더·만료·삭제 경계 시험용)."""
        aid = str(uuid.uuid4())
        self.attachments[aid] = {"conversation_id": conv, "uploader_id": uploader,
                                 "created_at": self.clock() - age, "message_id": None, "deleted": deleted}
        return aid

    def current_bound(self, aid: str) -> Optional[str]:
        meta = self.attachments.get(aid.lower())
        return None if meta is None else meta["message_id"]

    def _bindable(self, cid: str, raw_ids: list[str]) -> bool:
        """S/attachments/repo.ts:98-112 bindInTx: 중복 없음 + 모두 같은 대화·같은 업로더·미결속·미삭제·유예 안."""
        ids = [a.lower() for a in raw_ids]
        if len(set(ids)) != len(ids):
            return False
        not_before = self.clock() - self.attachment_ttl_s
        return all((meta := self.attachments.get(a)) is not None and meta["conversation_id"] == cid
                   and meta["uploader_id"] == BOT_ID and meta["message_id"] is None and not meta["deleted"]
                   and meta["created_at"] > not_before for a in ids)

    def _store_or_replay(self, cid: str, payload: dict):
        # 순서는 서버와 같다: (루트 가시성 404 → rateGuard = 위 강제 상태·429) → 키 조회·replay/충돌
        # → 루트 유효성 → 멘션 필터 → 첨부 결속(실패면 롤백: 저장·키·결속 0) → 저장.
        scope, norm = (cid, BOT_ID, payload["client_message_id"]), self._norm(payload)
        prior = self.idem.get(scope)
        if prior is not None:
            msg = self.current(prior["id"])
            mutated = msg is not None and (msg["edited_at"] is not None or msg["deleted_at"] is not None)
            if msg is None or any(prior[k] != norm[k] for k in ("thread_root_id", "attachment_ids")) or (
                    not mutated and (prior["body"] != norm["body"]
                                     or not self._same_mentions(prior, cid, norm["mentions"]))):
                self.posts.append({**payload, "_status": 409, "conversation_id": cid})
                return web.json_response({"error": "idempotency_conflict"}, status=409)
            # replay 는 새로 저장하지 않는다 — `_status` 200(= 새 저장) 집계에 들어가지 않게 따로 표시.
            self.posts.append({**payload, "_status": "replayed", "_http": 200, "conversation_id": cid})
            return self._committed({"message": msg, "seq": 1, "change_id": prior["change_id"],
                                    "mention_user_ids": list(msg.get("mention_user_ids") or [])}, 200)
        root = self.current(norm["thread_root_id"]) if norm["thread_root_id"] is not None else None
        if root is not None and (root.get("thread_root_id") is not None or root.get("deleted_at") is not None):
            self.posts.append({**payload, "_status": 400, "conversation_id": cid})  # repo.ts rootIsValid
            return web.json_response({"error": "invalid_thread_root"}, status=400)
        if not self._bindable(cid, list(payload.get("attachment_ids") or [])):
            self.posts.append({**payload, "_status": 400, "conversation_id": cid})
            return web.json_response({"error": "invalid_attachments"}, status=400)
        mentions = sorted(set(norm["mentions"]) & self._eligible(cid, BOT_ID))
        # `_status` 200 = 새로 저장(기존 테스트 집계 호환). 실제 HTTP 상태는 `_http`(201).
        self.posts.append({**payload, "_status": 200, "_http": 201, "conversation_id": cid})
        stored_root = norm["thread_root_id"].lower() if isinstance(norm["thread_root_id"], str) else None  # DB uuid 값
        msg = make_message(author=BOT_ID, body=payload["body"], thread_root_id=stored_root, conv=cid, mentions=mentions)
        msg["client_message_id"] = payload["client_message_id"]
        change = self.add(msg, cid)
        self.idem[scope] = {**norm, "thread_root_id": stored_root, "stored_mentions": mentions, "created_at": self.clock(),
                            "id": msg["id"], "change_id": change}
        for aid in norm["attachment_ids"]:
            self.attachments[aid]["message_id"] = msg["id"]
        return self._committed({"message": msg, "seq": 1, "change_id": change, "mention_user_ids": mentions}, 201)

    def _committed(self, body: dict, status: int):
        """커밋 뒤 응답 — 장애 주입 스위치를 연결 유실 → 본문 이상 → 3xx 순으로 하나만 적용."""
        if self.post_disconnect_after_commit > 0:
            self.post_disconnect_after_commit -= 1
            raise _Disconnect()
        if self.post_body_fault_after_commit:
            return self._broken(self.post_body_fault_after_commit.pop(0), body, status)
        if self.post_redirect_after_commit:
            return web.Response(status=self.post_redirect_after_commit.pop(0), headers={"Location": "/api/bot/v1/me"})
        return web.json_response(body, status=status)

    @staticmethod
    def _broken(kind: str, body: dict, status: int):
        raw = json.dumps(body).encode()
        if kind == "short_body":
            return _ShortBody(raw, status)
        if kind == "bad_status_line":
            return _BadStatusLine(raw, status)
        data = {"json_truncated": raw[: len(raw) // 2], "json_invalid": b'{"message": nope', "empty": b""}[kind]
        return web.Response(body=data, status=status, content_type="application/json")

    async def history(self, request):
        """봇 이력 GET: 원문(thread_root 없음)만, 최신 limit개(기본·최대 100) 오름차순, tombstone 키 보존."""
        self._log(request)
        self.history_calls += 1
        if self.history_delay:
            await asyncio.sleep(self.history_delay)
        if self.history_status:
            status = self.history_status.pop(0)
            return web.json_response({"error": {401: "unauthorized", 403: "forbidden"}.get(status, "error")},
                                     status=status)
        if self.history_disconnect > 0:
            self.history_disconnect -= 1
            raise _Disconnect()
        cid, limit = request.match_info["cid"], int(request.query.get("limit", 100))
        if not 1 <= limit <= 100:
            return web.json_response({"error": "invalid_request"}, status=400)
        latest: dict[str, tuple[str, dict]] = {}  # id → (처음 저장된 대화, 현재 상태), 처음 등장 순서 유지
        for _c, conv, m in self.changes:
            latest[m["id"]] = (latest[m["id"]][0] if m["id"] in latest else conv, m)
        roots = [m for conv, m in latest.values() if conv == cid and m.get("thread_root_id") is None]
        if self.history_extra is not None:
            roots = [*roots, *self.history_extra()]
        body = {"messages": roots[-limit:], "has_more": len(roots) > limit}
        if self.history_body_fault:
            resp = self._broken(self.history_body_fault.pop(0), body, 200)
            return await resp.send(request) if isinstance(resp, _ShortBody) else resp
        return web.json_response(body)

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
        self.attachments[aid] = {"conversation_id": rec["conversation_id"], "uploader_id": BOT_ID,
                                 "created_at": self.clock(), "message_id": None, "deleted": False}
        if self.upload_body_fault:
            return self._broken(self.upload_body_fault.pop(0), {}, 201)
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
        mid, payload = request.match_info["mid"], await request.json()
        self.patches.append((mid, payload))
        # S/messages/repo.ts:266 editIn: 기존 행의 본문·edited_at 만 갱신(id·client_message_id·대화 보존).
        base, conv = self.current(mid), self._first_conv(mid)
        # 숨김 검사도 `_visible_in`과 같은 소문자 정규화(S/bots/routes.ts:317,221-223,201-203).
        hidden = mid.lower() in {h.lower() for h in self.hidden_message_ids}
        if base is None or conv is None or hidden or base.get("deleted_at") is not None:
            return web.json_response({"error": "not_found"}, status=404)
        if base["author_id"] != BOT_ID:
            return web.json_response({"error": "forbidden"}, status=403)
        mentions = sorted(set(payload.get("mention_user_ids") or []) & self._eligible(conv, BOT_ID))
        msg = {**base, "body": payload["body"], "edited_at": iso(self.clock()), "mention_user_ids": mentions}
        change = self.add(msg, conv, op="edit")
        return web.json_response({"message": msg, "seq": 1, "change_id": change, "mention_user_ids": mentions})

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
        app = web.Application(client_max_size=11 * 1024 * 1024, middlewares=[_disconnect_middleware])
        p = "/api/bot/v1"
        app.router.add_get(f"{p}/me", self.me)
        app.router.add_get(f"{p}/sync", self.sync)
        app.router.add_get(f"{p}/sync/snapshot", self.snapshot)
        app.router.add_post(f"{p}/conversations/{{cid}}/messages", self.post)
        app.router.add_get(f"{p}/conversations/{{cid}}/messages", self.history)
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
