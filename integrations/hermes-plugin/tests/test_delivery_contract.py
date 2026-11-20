"""설계 r4 §Q1·§4 단계 3 — standalone 전달 계약(청크 상태 머신·키 재사용·확인 GET·불명 반환).

가짜 서버(단계 2)의 장애 주입으로 「커밋 후 응답 유실」을 만들고, standalone_send 결과와 서버 저장 수를 본다.
"""

from __future__ import annotations

import functools

from aiohttp import web

from conftest import BOT_ID, DM_ID, OWNER_ID, TOKEN, make_message

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
TWO_CHUNKS = "가" * 4500  # 어댑터 내부 청크 2개


def _cfg(server):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})


def _stored(server) -> list[dict]:
    """새로 저장된 게시(replay·거부 제외)."""
    return [p for p in server.posts if p["_status"] == 200]


def _post_requests(server) -> list:
    return [r for r in server.requests if r[0] == "POST" and r[1].endswith("/messages")]


def _me_gets(server) -> int:
    return sum(1 for m, p, _h in server.requests if m == "GET" and p.endswith("/me"))


def _record_sleep(monkeypatch) -> list[float]:
    """재시도 대기를 실제로 기다리지 않고 기록만 한다."""
    import ohmyslack.adapter as adapter_mod
    delays: list[float] = []

    async def sleep(delay: float) -> None:
        delays.append(delay)
    monkeypatch.setattr(adapter_mod, "BotClient", functools.partial(adapter_mod.BotClient, sleep=sleep))
    return delays


def _after_first_store(server, then) -> None:
    """첫 `_store_or_replay` 호출(성공·끊김 모두) 뒤에 `then()`으로 장애 스위치를 바꾼다."""
    orig = server._store_or_replay
    calls = {"n": 0}

    def wrapped(cid, payload):
        calls["n"] += 1
        try:
            return orig(cid, payload)
        finally:
            if calls["n"] == 1:
                then()
    server._store_or_replay = wrapped


def _stored_id(server, key: str) -> str:
    return server.idem[(DM_ID, BOT_ID, key)]["id"]


async def _send(server, message: str = "아침 브리핑", media_files=None) -> dict:
    from ohmyslack.adapter import standalone_send
    return await standalone_send(_cfg(server), DM_ID, message, media_files=media_files)


# 가드 ---------------------------------------------------------------------------------------------
async def test_disconnect_twice_after_commit_reuses_key(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_disconnect_after_commit = 2
    out = await _send(server)
    assert out.get("success") is True
    posts = _post_requests(server)
    assert len(posts) == 3
    assert len({p["client_message_id"] for p in server.posts}) == 1  # 모든 시도가 같은 키
    stored = _stored(server)
    assert len(stored) == 1  # 3번째는 replay 200 — 서버 메시지 1개
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])
    assert server.history_calls == 0


async def test_first_403_is_rejected_no_retry(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_status = [403]
    out = await _send(server)
    assert "error" in out and "success" not in out
    assert "HTTP 403" in out["error"]
    assert len(_post_requests(server)) == 1 and server.history_calls == 0


async def test_no_reupload_after_chunk0_attempted(server, monkeypatch, tmp_path):
    _record_sleep(monkeypatch)
    mp3 = tmp_path / "briefing.mp3"
    mp3.write_bytes(MP3)
    server.post_disconnect_after_commit = 2
    out = await _send(server, "아침 브리핑", [(str(mp3), True)])
    assert out.get("success") is True
    assert len(server.uploads) == 1  # 재업로드 없음(새 첨부 ID면 같은 키 재전송이 409)
    aid = server.uploads[0]["attachment_id"]
    assert all(p.get("attachment_ids") == [aid] for p in server.posts)
    assert len(_stored(server)) == 1


# RED ---------------------------------------------------------------------------------------------
async def test_all_attempts_lost_history_confirms(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_disconnect_after_commit = 4  # 재시도 상한까지 전부 커밋 후 끊김
    out = await _send(server)
    assert "error" not in out and out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])
    assert server.history_calls == 1


async def test_payload_error_once_then_history_confirms(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_body_fault_after_commit = ["short_body"]  # 수신 단계 ClientPayloadError
    out = await _send(server)
    assert "error" not in out and out.get("success") is True
    assert len(_post_requests(server)) == 1  # ClientPayloadError는 재시도하지 않는다
    assert server.history_calls == 1
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])


async def test_bad_json_2xx_is_ambiguous_not_exception(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_body_fault_after_commit = ["json_invalid"]  # 201 + 깨진 JSON(커밋됨)
    out = await _send(server)  # 예외가 밖으로 빠지지 않는다
    assert "error" not in out and out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])


async def test_missing_message_id_not_counted(server, monkeypatch):
    _record_sleep(monkeypatch)
    orig = server._committed
    calls = {"n": 0}

    def no_id_once(body, status):
        calls["n"] += 1
        if calls["n"] == 1:
            return web.json_response({"message": {}}, status=201)  # 커밋됐지만 ID 없는 응답
        return orig(body, status)
    server._committed = no_id_once
    out = await _send(server)
    assert out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])  # 빈 문자열을 게시로 세지 않음


async def test_redirect_not_followed_is_ambiguous(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_redirect_after_commit = [302]  # Location = /me (따라가면 POST→GET /me 200)
    out = await _send(server)
    assert _me_gets(server) == 1  # 리다이렉트를 따라가지 않았다(처음 /me 1회뿐)
    assert out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])


async def test_history_match_requires_author_and_top_level(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_status = [500] * 4  # 저장 안 됨 + 모호(5xx)

    def lookalikes() -> list[dict]:
        key = server.posts[0]["client_message_id"]
        other_author = make_message(author=OWNER_ID, body="x")
        reply = make_message(author=BOT_ID, body="x", thread_root_id=make_message()["id"])
        for m in (other_author, reply):
            m["client_message_id"] = key
        return [other_author, reply]
    server.history_extra = lookalikes
    out = await _send(server)
    assert "success" not in out and "delivery_unknown chunk 1/1" in out["error"]  # not_found = 불명 유지
    assert server.history_calls == 1 and _stored(server) == []


async def test_check_failed_preserves_partial_success(server, monkeypatch):
    _record_sleep(monkeypatch)

    def lose_rest() -> None:
        server.post_disconnect_after_commit = 4
    _after_first_store(server, lose_rest)
    server.history_status = [403]
    out = await _send(server, TWO_CHUNKS)
    assert "error" not in out and out.get("success") is True
    assert "text: partial_delivery 1/2" in out["warnings"]
    assert "text: delivery_unknown chunk 2" in out["warnings"]
    first = _stored(server)[0]
    assert out["message_id"] == _stored_id(server, first["client_message_id"])


async def test_chunk0_unknown_returns_delivery_unknown_error(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_disconnect_after_commit = 4
    # 확인 GET도 실패(check_failed:connection). aiohttp는 재사용 연결이 끊긴 GET을 1회 자동 재전송하므로
    # (aiohttp/client.py:739-740·910-912) 두 번 끊어야 클라이언트에 연결 오류가 보인다.
    server.history_disconnect = 2
    out = await _send(server)
    assert "success" not in out
    assert "ohmyslack standalone send: delivery_unknown chunk 1/1" in out["error"]
    assert "media_delivered" not in out


async def test_409_not_promoted_by_history(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_disconnect_after_commit = 1  # 첫 시도 커밋 후 끊김(이력에 키 있음)

    def conflict_next() -> None:
        server.post_status = [409]
    _after_first_store(server, conflict_next)
    out = await _send(server)
    assert "success" not in out
    assert "idempotency_conflict chunk 1/1" in out["error"]
    assert server.history_calls == 0  # 409는 확인 GET으로 성공에 올리지 않는다
    assert len(_stored(server)) == 1


async def test_ambiguous_then_403_stays_ambiguous(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_status = [500, 403]  # 모호(5xx) 뒤 403 — 앞 모호성을 지우지 않는다
    out = await _send(server)
    assert "success" not in out
    assert "delivery_unknown chunk 1/1" in out["error"] and "HTTP 403" not in out["error"]
    assert server.history_calls == 1


async def test_429_after_ambiguous_goes_to_history_without_wait(server, monkeypatch):
    sleeps = _record_sleep(monkeypatch)
    server.post_disconnect_after_commit = 1

    def rate_limit_next() -> None:
        server.post_status = [429]
    _after_first_store(server, rate_limit_next)
    out = await _send(server)
    assert sleeps == [1.0]  # 끊김 뒤 백오프 1회뿐, 429 Retry-After는 기다리지 않는다
    assert len(_post_requests(server)) == 2 and server.history_calls == 1
    assert out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])


# 단계 3 Codex 1차 수정 ---------------------------------------------------------------------------
# P1: 커밋 후 상태줄 파싱 실패(일반 ClientResponseError)도 모호 시도로 기록 → 확인 GET·반환표 경로.
async def test_bad_status_line_after_commit_history_confirms(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_body_fault_after_commit = ["bad_status_line", "bad_status_line"]  # 같은 키 1회 더도 깨짐
    out = await _send(server)
    assert "error" not in out and out.get("success") is True
    stored = _stored(server)
    assert len(stored) == 1
    assert out["message_id"] == _stored_id(server, stored[0]["client_message_id"])
    assert server.history_calls == 1


async def test_bad_status_line_and_check_failed_is_delivery_unknown(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.post_body_fault_after_commit = ["bad_status_line", "bad_status_line"]
    server.history_disconnect = 2  # aiohttp GET 자동 재전송 1회 흡수(위 chunk0_unknown 테스트 참조)
    out = await _send(server)
    assert "success" not in out
    assert "ohmyslack standalone send: delivery_unknown chunk 1/1" in out["error"]
    assert len(_stored(server)) == 1


async def test_bad_status_line_on_later_chunk_warns_delivery_unknown(server, monkeypatch):
    _record_sleep(monkeypatch)

    def break_rest() -> None:
        server.post_body_fault_after_commit = ["bad_status_line", "bad_status_line"]
    _after_first_store(server, break_rest)
    server.history_status = [403]
    out = await _send(server, TWO_CHUNKS)
    assert "error" not in out and out.get("success") is True
    assert "text: partial_delivery 1/2" in out["warnings"]
    assert "text: delivery_unknown chunk 2" in out["warnings"]
    first = _stored(server)[0]
    assert out["message_id"] == _stored_id(server, first["client_message_id"])


# P2: /me·업로드 2xx 본문이 JSON 아님·dict 아님 → 함수 밖으로 새지 않는다.
async def test_upload_broken_json_warns_that_file_only(server, monkeypatch, tmp_path):
    _record_sleep(monkeypatch)
    first, second = tmp_path / "a.mp3", tmp_path / "b.mp3"
    first.write_bytes(MP3)
    second.write_bytes(MP3)
    server.upload_body_fault = ["json_invalid"]  # 첫 파일만
    out = await _send(server, "아침 브리핑", [(str(first), True), (str(second), True)])
    assert "error" not in out and out.get("success") is True
    assert out["warnings"] == ["a.mp3: upload_failed"]
    stored = _stored(server)
    assert len(stored) == 1 and stored[0]["body"] == "아침 브리핑"
    assert stored[0]["attachment_ids"] == [server.uploads[1]["attachment_id"]]  # 다른 파일은 진행


async def test_upload_empty_2xx_warns_and_text_sent(server, monkeypatch, tmp_path):
    _record_sleep(monkeypatch)
    mp3 = tmp_path / "briefing.mp3"
    mp3.write_bytes(MP3)
    server.upload_body_fault = ["empty"]  # 201 + 빈 본문 → aiohttp json() None
    out = await _send(server, "아침 브리핑", [(str(mp3), True)])
    assert "error" not in out and out.get("success") is True
    assert out["warnings"] == ["briefing.mp3: upload_failed"]
    stored = _stored(server)
    assert len(stored) == 1 and "attachment_ids" not in stored[0]


async def test_me_broken_json_is_send_error(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.me_body_fault = ["json_invalid"]
    out = await _send(server)
    assert "success" not in out
    assert out["error"].startswith("ohmyslack standalone send: ")
    assert _post_requests(server) == [] and server.uploads == []


async def test_me_empty_2xx_is_send_error(server, monkeypatch):
    _record_sleep(monkeypatch)
    server.me_body_fault = ["empty"]
    out = await _send(server)
    assert "success" not in out
    assert out["error"].startswith("ohmyslack standalone send: ")
    assert _post_requests(server) == []
