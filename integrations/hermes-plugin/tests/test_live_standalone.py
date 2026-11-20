"""실서버 live(-m live, Issue #47 레인 A): standalone 첨부 실발송 E2E + 가짜 서버 400/404 규칙 실서버 대조.

기본 실행에서는 빠진다(pytest.ini `-m "not live"` + `OHMYSLACK_LIVE_E2E=1` 필요). env는 `scripts/live-e2e.sh`가 준비한다
(실행별 테스트 스키마·임의 포트 봇 리스너). 운영 서버(127.0.0.1:8787/8788)는 절대 가리키지 않는다 — `OHMYSLACK_BOT_URL`만 쓰고
운영 포트면 실패시킨다. 토큰 값은 출력하지 않는다.

- `OHMYSLACK_BOT_URL`: 봇 리스너 origin(루프백, `validate_bot_url` 통과)
- `OHMYSLACK_BOT_TOKEN_FILE`(또는 `OHMYSLACK_BOT_TOKEN`): 봇 Bearer 토큰. 격리 래퍼 `--run-live`는 값을 env에 싣지 않고 0600 파일
  경로만 넘긴다(test_live_e2e.py `_secret`과 같은 규칙).

B 대조 방식: 같은 요청을 (1) conftest 가짜 서버(`server` fixture)와 (2) 실서버 봇 API에 보내 상태 코드·오류 코드가 같은지 본다.
오류 본문 모양은 서로 다르다(가짜 `{"error": "<code>"}`, 실서버 `{"error": {"code", "request_id"}}` — S/http/errors.ts:15-17) —
플러그인은 오류 본문을 읽지 않고 상태만 보므로 코드 문자열만 정규화해 비교하고, 실서버 쪽은 모양까지 단언한다.
규칙 목록·근거 file:line은 dev/active/issue47-live/REPORT.md 표.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlsplit

import pytest

from conftest import BOT_ID, DM_ID, FIXTURE_BEARER


def _secret(name: str) -> str:
    """`<name>` env 값, 없으면 `<name>_FILE` 이 가리키는 파일 내용(끝 줄바꿈 제거). 둘 다 없으면 ""(test_live_e2e.py와 같음)."""
    value = os.environ.get(name, "")
    path = os.environ.get(f"{name}_FILE", "")
    if value or not path:
        return value
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().rstrip("\r\n")
    except OSError:
        return ""


# conftest의 autouse `_isolated_env`가 테스트 본문 전에 봇 env를 지우므로 import 시점에 읽는다(test_live_e2e.py와 같은 패턴).
LIVE = os.environ.get("OHMYSLACK_LIVE_E2E") == "1"
BOT_URL = os.environ.get("OHMYSLACK_BOT_URL", "")
BOT_TOKEN = _secret("OHMYSLACK_BOT_TOKEN")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not (LIVE and BOT_URL and BOT_TOKEN),
                       reason="live standalone: OHMYSLACK_LIVE_E2E=1·OHMYSLACK_BOT_URL·OHMYSLACK_BOT_TOKEN(_FILE) 필요"),
]

API = "/api/bot/v1"
PROD_PORTS = frozenset({8787, 8788})  # 운영 사람/봇 리스너 — live 테스트 대상 금지
# tests/test_standalone_attach.py:12와 같은 최소 mp3: ID3v2(크기 0) + MPEG1 Layer III 128 kbps 44.1 kHz 프레임 sync.
# 실서버 판정(S/attachments/sniff.ts:106-137 sniffMp3 — ID3 뒤 유효 프레임 sync, service.ts:109-115 선언 MIME 일치)을 통과한다.
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64


@dataclass(frozen=True)
class Side:
    """요청 대상 하나(가짜 또는 실서버): origin·토큰·봇 DM id·봇 user id."""

    name: str
    base: str
    token: str = field(repr=False)  # 단언 실패 출력(pytest 재작성의 중간값 repr)에 토큰이 실리지 않게
    dm: str
    bot_id: str


@dataclass(frozen=True)
class Pair:
    session: Any
    fake: Optional[Side]
    real: Side


def _real_base() -> str:
    from ohmyslack.client import validate_bot_url
    base = validate_bot_url(BOT_URL)  # 루프백 http origin만
    port = urlsplit(base).port
    if port in PROD_PORTS:
        pytest.fail(f"live test refuses production bot port {port}")
    return base


async def _call(session, side: Side, method: str, path: str, *, json: Any = None,
                params: Optional[dict] = None) -> tuple[int, Any]:
    """원시 요청 1회 → (상태, JSON 본문 또는 None). 재시도·리다이렉트 없음(대조는 첫 응답만 본다)."""
    async with session.request(method, f"{side.base}{API}{path}", json=json, params=params,
                               headers={"Authorization": f"Bearer {side.token}"}, allow_redirects=False) as resp:
        try:
            body = await resp.json(content_type=None)
        except ValueError:
            body = None
        return resp.status, body


def _code(side: Side, body: Any) -> Optional[str]:
    """오류 코드 문자열. 실서버는 `{"error": {"code", "request_id"}}` 모양까지 확인한다(S/http/errors.ts:15-17)."""
    err = body.get("error") if isinstance(body, dict) else None
    if side.name == "real":
        assert isinstance(err, dict) and "request_id" in err, f"real error body shape: {type(err).__name__}"
        return err.get("code")
    return err.get("code") if isinstance(err, dict) else err


async def _post(pair: Pair, side: Side, payload: dict) -> tuple[int, Any]:
    return await _call(pair.session, side, "POST", f"/conversations/{side.dm}/messages", json=payload)


def _sides(pair: Pair) -> list[Side]:
    return [s for s in (pair.fake, pair.real) if s is not None]


async def _real_side(session) -> Side:
    real = Side("real", _real_base(), BOT_TOKEN, "", "")
    status, me = await _call(session, real, "GET", "/me")
    assert status == 200 and isinstance(me, dict), f"/me -> {status}"
    convs = me.get("conversations") or []
    dm = next((str(c["id"]) for c in convs if isinstance(c, dict) and c.get("kind") == "dm"), None)
    dm = dm or str((me.get("conversation_ids") or [""])[0])
    assert dm and me.get("id"), "live /me has no owner DM"
    return Side("real", real.base, BOT_TOKEN, dm, str(me["id"]))


@pytest.fixture
async def pair(server):
    from ohmyslack.client import new_session
    async with new_session() as session:
        real = await _real_side(session)
        fake = Side("fake", server.base, FIXTURE_BEARER, DM_ID, BOT_ID)
        yield Pair(session, fake, real)


async def _expect_same(pair: Pair, expected: tuple[int, str], make) -> None:
    """`make(side)` → (상태, 본문) 을 가짜·실서버 각각에 부르고, 둘 다 `expected`(가짜 규칙 값)와 같아야 한다."""
    got = {}
    for side in _sides(pair):
        status, body = await make(side)
        got[side.name] = (status, _code(side, body))
    assert got == {s.name: expected for s in _sides(pair)}, got


# ---------------------------------------------------------------- A. standalone 첨부 실발송 E2E

async def _history_ids(session, side: Side) -> list[dict]:
    status, body = await _call(session, side, "GET", f"/conversations/{side.dm}/messages", params={"limit": "100"})
    assert status == 200 and isinstance(body, dict), f"history -> {status}"
    return list(body.get("messages") or [])


async def test_live_standalone_long_text_with_mp3_binds_attachment_to_first_chunk_only(tmp_path):
    from gateway.config import PlatformConfig
    from gateway.platforms.base import BasePlatformAdapter
    from ohmyslack.adapter import OhmySlackAdapter, standalone_send
    from ohmyslack.client import new_session

    marker = f"live-standalone {uuid.uuid4()}"
    # 줄마다 표지 → 어느 청크에도 표지가 든다. ~6.1k자 = MAX_MESSAGE_LENGTH(4000) 기준 청크 ≥ 2.
    text = "\n".join(f"{marker} line {i:03d} " + "." * 40 for i in range(60))
    chunks = BasePlatformAdapter.truncate_message(text, OhmySlackAdapter.MAX_MESSAGE_LENGTH)
    n = len(chunks)
    assert n >= 2
    path = tmp_path / "briefing.mp3"
    path.write_bytes(MP3)

    async with new_session() as session:
        real = await _real_side(session)
        cfg = PlatformConfig(enabled=True, token=BOT_TOKEN, extra={"url": real.base})

        async def _one_call(seen: set[str]) -> list[dict]:
            out = await standalone_send(cfg, real.dm, text, media_files=[(str(path), True)])
            assert out.get("success") is True, out.get("error")
            assert out.get("media_delivered") is True
            assert "warnings" not in out, out.get("warnings")
            new = [m for m in await _history_ids(session, real) if m["id"] not in seen]
            # 이력 필드 이름: S/messages/routes.ts:55-83 toView. 이력은 seq 오름차순(원문만).
            assert [m["author_id"] for m in new] == [real.bot_id] * n  # 중복 0: 새 메시지 = 청크 수
            assert [m["body"] for m in new] == chunks  # 청크 순서 보존
            assert all(marker in m["body"] and m["thread_root_id"] is None for m in new)
            seqs = [m["seq"] for m in new]
            assert seqs == sorted(seqs) and len(set(seqs)) == n
            assert len({m["client_message_id"] for m in new}) == n  # 청크마다 키 하나
            first = new[0]["attachments"]
            assert len(first) == 1 and first[0]["mime"] == "audio/mpeg" and first[0]["byte_size"] == len(MP3)
            assert all(m["attachments"] == [] for m in new[1:])  # 첨부는 첫 청크에만
            assert out.get("message_id") == new[-1]["id"]
            return new

        before = {m["id"] for m in await _history_ids(session, real)}
        first_run = await _one_call(before)
        # 같은 호출 재실행: 키는 호출마다 새 uuid4(adapter.py:1124) → 새 메시지 n건(replay 아님), 첨부도 새로 업로드·결속.
        second_run = await _one_call(before | {m["id"] for m in first_run})
        assert not ({m["client_message_id"] for m in first_run} & {m["client_message_id"] for m in second_run})
        assert first_run[0]["attachments"][0]["id"] != second_run[0]["attachments"][0]["id"]
        marked = [m for m in await _history_ids(session, real) if marker in (m.get("body") or "")]
        assert len(marked) == 2 * n


# ---------------------------------------------------------------- B. 가짜 400/404 규칙 실서버 대조

async def test_parity_missing_root_reply_is_404_before_replay(pair):
    """가짜 conftest.py post 루트 판정(루트 가시성 404가 rateGuard·replay보다 먼저) ↔ 실서버 bots/routes.ts:206-209·314
    threadRootGuard(sendAs의 replay 판정 전). 같은 키로 이미 저장된 최상위 메시지가 있어도 없는 루트면 404."""
    async def make(side: Side):
        key = str(uuid.uuid4())
        status, _ = await _post(pair, side, {"client_message_id": key, "body": "parity root-404 seed"})
        assert status == 201, (side.name, status)
        return await _post(pair, side, {"client_message_id": key, "body": "parity root-404 seed",
                                        "thread_root_id": str(uuid.uuid4())})
    await _expect_same(pair, (404, "not_found"), make)


async def test_parity_missing_root_fresh_key_is_404(pair):
    async def make(side: Side):
        return await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "parity root-404",
                                        "thread_root_id": str(uuid.uuid4())})
    await _expect_same(pair, (404, "not_found"), make)


@pytest.mark.parametrize("body", ["", "   \n\t"], ids=["empty", "whitespace"])
async def test_parity_blank_body_is_400_invalid_request(pair, body):
    """가짜 conftest.py post 본문 판정 ↔ 실서버 shared/messages.ts:16-19 bodySchema(trim 비면 거부) → messages/routes.ts:33-36·110."""
    async def make(side: Side):
        return await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": body})
    await _expect_same(pair, (400, "invalid_request"), make)


async def test_parity_reply_as_root_is_400_invalid_thread_root(pair):
    """가짜 conftest.py:390-393(루트가 답글·삭제면 400) ↔ 실서버 messages/service.ts:73(store bad_root)."""
    async def make(side: Side):
        status, root = await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "parity root"})
        assert status == 201, (side.name, status)
        status, reply = await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "parity reply",
                                                 "thread_root_id": root["message"]["id"]})
        assert status == 201, (side.name, status)
        return await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "parity nested",
                                        "thread_root_id": reply["message"]["id"]})
    await _expect_same(pair, (400, "invalid_thread_root"), make)


async def test_parity_unknown_attachment_is_400_invalid_attachments(pair):
    """가짜 conftest.py:394-396·363-371 `_bindable` ↔ 실서버 messages/service.ts:74(store bad_attachments)."""
    async def make(side: Side):
        return await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "parity attach",
                                        "attachment_ids": [str(uuid.uuid4())]})
    await _expect_same(pair, (400, "invalid_attachments"), make)


async def test_parity_same_key_different_body_is_409(pair):
    """(400/404 밖이지만 같은 게시 경로) 가짜 conftest.py:381-385 ↔ 실서버 messages/service.ts:72."""
    async def make(side: Side):
        key = str(uuid.uuid4())
        status, _ = await _post(pair, side, {"client_message_id": key, "body": "parity idem a"})
        assert status == 201, (side.name, status)
        return await _post(pair, side, {"client_message_id": key, "body": "parity idem b"})
    await _expect_same(pair, (409, "idempotency_conflict"), make)


@pytest.mark.parametrize("limit", ["0", "101"])
async def test_parity_history_limit_out_of_range_is_400(pair, limit):
    """가짜 conftest.py:444-446 ↔ 실서버 shared/messages.ts:52 limit 1..100 → messages/routes.ts:123-125 parseOr400."""
    async def make(side: Side):
        return await _call(pair.session, side, "GET", f"/conversations/{side.dm}/messages", params={"limit": limit})
    await _expect_same(pair, (400, "invalid_request"), make)


async def test_parity_patch_unknown_message_is_404(pair):
    """가짜 conftest.py:495-499 ↔ 실서버 bots/routes.ts:317 guarded('message') → messages/service.ts:64-66 resolveAccess."""
    async def make(side: Side):
        return await _call(pair.session, side, "PATCH", f"/messages/{uuid.uuid4()}", json={"body": "parity edit"})
    await _expect_same(pair, (404, "not_found"), make)


async def test_parity_replies_unknown_root_is_404(pair):
    """가짜 conftest.py:513-515 ↔ 실서버 bots/routes.ts:311 guarded('message','read') → resolveAccess 404."""
    async def make(side: Side):
        return await _call(pair.session, side, "GET", f"/messages/{uuid.uuid4()}/replies", params={"limit": "1"})
    await _expect_same(pair, (404, "not_found"), make)


async def test_parity_download_unknown_attachment_is_404(pair):
    """가짜 conftest.py:485-486 ↔ 실서버 bots/routes.ts:167-173·180 → attachments/service.ts:156-158."""
    async def make(side: Side):
        return await _call(pair.session, side, "GET", f"/attachments/{uuid.uuid4()}")
    await _expect_same(pair, (404, "not_found"), make)


# ---------------------------------------------------------------- B'. 형식 오류 본문 + 없는 루트 — 루트 판정 생략(400)

async def test_parity_blank_body_with_missing_root_is_400_not_404(pair):
    """실서버 threadRootGuard는 본문 전체가 스키마를 통과할 때만 루트를 본다(bots/routes.ts:190-195 — 형식 오류는 sendAs의 400).
    가짜도 같은 순서로 맞췄다(conftest.py post: body_ok일 때만 루트 404)."""
    async def make(side: Side):
        return await _post(pair, side, {"client_message_id": str(uuid.uuid4()), "body": "",
                                        "thread_root_id": str(uuid.uuid4())})
    await _expect_same(pair, (400, "invalid_request"), make)
