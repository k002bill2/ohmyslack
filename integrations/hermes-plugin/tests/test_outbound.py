"""send·분할·429·edit·standalone·register 스모크·커서 파일."""

from __future__ import annotations

import json

import pytest

from conftest import DM_ID, TOKEN, wait_for


def _ok(server):
    return [p for p in server.posts if p["_status"] == 200]


def _split(text):
    from ohmyslack.adapter import OhmySlackAdapter
    return OhmySlackAdapter.truncate_message(text, OhmySlackAdapter.MAX_MESSAGE_LENGTH)


@pytest.mark.parametrize("n,chunks", [(3999, 1), (4000, 1), (4001, 2)])
def test_split_boundaries_in_code_points(n, chunks):
    parts = _split("a" * n)
    assert len(parts) == chunks
    assert all(len(p) <= 4000 for p in parts)


def test_split_keeps_surrogate_pairs_intact():
    text = "😀" * 4001  # 비BMP: UTF-16 서로게이트 쌍 4001개 = 4001 code point
    parts = _split(text)
    assert len(parts) == 2
    assert all(len(p) <= 4000 for p in parts)
    for p in parts:
        p.encode("utf-8")  # 외톨이 서로게이트가 있으면 UnicodeEncodeError
        assert not any(0xD800 <= ord(ch) <= 0xDFFF for ch in p)
    assert sum(p.count("😀") for p in parts) == 4001


def test_split_preserves_code_fences():
    body = "```python\n" + "\n".join(f"x_{i} = {i}" for i in range(800)) + "\n```"
    parts = _split(body)
    assert len(parts) > 1
    for p in parts:
        assert len(p) <= 4000
        assert p.count("```") % 2 == 0
        assert p.lstrip().startswith("```python")


async def test_send_reply_uses_thread_root_and_retries_429_idempotently(server, make_adapter, fake_sleep):
    adapter = make_adapter()
    assert await adapter.connect()
    server.post_429 = 1
    res = await adapter.send(DM_ID, "answer", reply_to="m-1", metadata={"thread_id": "root-1"})
    assert res.success
    attempts = [p for p in server.posts if p["body"] == "answer"]
    assert [a["_status"] for a in attempts] == [429, 200]
    assert attempts[0]["client_message_id"] == attempts[1]["client_message_id"]
    assert attempts[1]["thread_root_id"] == "root-1"
    assert 1.0 in fake_sleep.calls


async def test_send_429_exhausted_returns_rate_limited(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    server.post_429 = 10
    res = await adapter.send(DM_ID, "x")
    assert not res.success and res.error_kind == "rate_limited" and res.retryable
    assert res.retry_after == 1.0


async def test_send_long_message_posts_chunks_in_same_thread(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    res = await adapter.send(DM_ID, "b" * 9000, metadata={"thread_id": "root-9"})
    ok = _ok(server)
    assert res.success and len(ok) == 3
    assert all(p["thread_root_id"] == "root-9" for p in ok)
    assert len(set(p["client_message_id"] for p in ok)) == 3
    assert res.continuation_message_ids and res.message_id == res.continuation_message_ids[-1]


async def test_reply_to_a_reply_is_corrected_to_root(server, make_adapter):
    from conftest import make_message
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    root = make_message(body="top")
    reply = make_message(body="child", thread_root_id=root["id"])
    await server.push_live(root)
    await server.push_live(reply)
    await wait_for(lambda: len(adapter.events) == 2)
    await adapter.send(DM_ID, "ack", reply_to=reply["id"])
    assert _ok(server)[-1]["thread_root_id"] == root["id"]


async def test_edit_message_patches(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    res = await adapter.edit_message(DM_ID, "mid-1", "edited")
    assert res.success and server.patches == [("mid-1", {"body": "edited"})]
    too_long = await adapter.edit_message(DM_ID, "mid-1", "z" * 4001)
    assert not too_long.success and too_long.error_kind == "too_long"


async def test_attachment_methods_fall_back_to_text(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    res = await adapter.send_voice(DM_ID, "/tmp/a.ogg")
    assert res.success
    assert _ok(server)[-1]["body"] == "(첨부 전송은 아직 지원하지 않습니다)"


async def test_standalone_sender_posts_top_level_to_home_channel(server):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import standalone_send
    cfg = PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})
    out = await standalone_send(cfg, DM_ID, "아침 브리핑", thread_id="ignored")
    assert out["success"] is True and out["message_id"]
    ok = _ok(server)
    assert len(ok) == 1 and ok[0]["conversation_id"] == DM_ID and "thread_root_id" not in ok[0]
    bad = await standalone_send(PlatformConfig(enabled=True, token=TOKEN, extra={"url": "http://10.1.1.1:1"}),
                                DM_ID, "x")
    assert "error" in bad and TOKEN not in bad["error"]


def test_register_smoke_with_fake_ctx():
    import ohmyslack
    from ohmyslack.adapter import OhmySlackAdapter, standalone_send

    class Ctx:
        def __init__(self):
            self.calls = []

        def register_platform(self, **kwargs):
            self.calls.append(kwargs)

    ctx = Ctx()
    ohmyslack.register(ctx)
    assert len(ctx.calls) == 1
    kw = ctx.calls[0]
    assert kw["name"] == "ohmyslack"
    assert kw["adapter_factory"] is OhmySlackAdapter
    assert kw["cron_deliver_env_var"] == "OHMYSLACK_HOME_CHANNEL"
    assert kw["max_message_length"] == 0  # 단일 호출 계약: Hermes 외부 청킹 끔(길이는 어댑터 내부 MAX_MESSAGE_LENGTH)
    assert kw["standalone_sender_fn"] is standalone_send
    assert kw["allowed_users_env"] == "OHMYSLACK_ALLOWED_USERS"
    assert "allow_all_env" not in kw
    assert kw["check_fn"]() is True
    from gateway.platform_registry import PlatformEntry
    PlatformEntry(**kw)  # 실제 코어가 모르는 키가 있으면 TypeError


def test_platform_resolves_after_registration():
    from gateway.config import Platform
    assert Platform("ohmyslack").value == "ohmyslack"


def test_cursor_store_atomic_and_tolerant(tmp_path):
    from ohmyslack.cursor import CursorState, CursorStore
    store = CursorStore(tmp_path / "nested" / "cursor.json")
    assert store.load() is None
    store.save(CursorState(change_id=42, saved_at=1.5, recent_ids=("a", "b")))
    assert store.load() == CursorState(change_id=42, saved_at=1.5, recent_ids=("a", "b"))
    assert [p.name for p in (tmp_path / "nested").iterdir()] == ["cursor.json"]  # 임시 파일 잔재 없음
    raw = json.loads(store.path.read_text())
    assert set(raw) == {"change_id", "saved_at", "recent_ids"}
    store.path.write_text("{broken")
    assert store.load() is None


# ---------- Codex r2 회귀 ----------
async def test_partial_send_failure_is_not_retryable(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    # 첫 청크는 게시되고 두 번째 청크부터 429가 소진된 상황
    adapter._client.post_message = _wrap_post(adapter._client.post_message, fail_from=2)
    res = await adapter.send(DM_ID, "c" * 9000)
    assert not res.success and res.retryable is False
    assert len(res.continuation_message_ids) == 1
    assert res.raw_response["partial_message_ids"] == list(res.continuation_message_ids)


def _wrap_post(fn, *, fail_from):
    from ohmyslack.client import BotApiError
    calls = {"n": 0}

    async def wrapped(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] >= fail_from:
            raise BotApiError(429, "/conversations", retry_after=1.0)
        return await fn(*args, **kwargs)

    return wrapped


async def test_backlog_notice_kept_when_post_fails(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    adapter._backlog = {DM_ID: 2}
    server.post_429 = 10
    await adapter._flush_backlog()
    assert adapter._backlog == {DM_ID: 2}
    server.post_429 = 0
    await adapter._flush_backlog()
    assert adapter._backlog == {}
    assert [p["body"] for p in _ok(server)] == ["오프라인 동안 받은 2건은 처리하지 않았습니다"]


# ---------- FIX r2 회귀 (Codex r4 P2, r3 잔여 P2) ----------
NOTICE_2 = "오프라인 동안 받은 2건은 처리하지 않았습니다"


async def test_backlog_restored_when_notice_send_is_cancelled(server, make_adapter):
    import asyncio
    adapter = make_adapter()
    assert await adapter.connect()
    adapter._backlog = {DM_ID: 2}
    started, never = asyncio.Event(), asyncio.Event()

    async def blocked_post(*_args, **_kwargs):
        started.set()
        await never.wait()

    adapter._client.post_message = blocked_post
    task = asyncio.create_task(adapter._flush_backlog())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert adapter._backlog == {DM_ID: 2}
    await adapter.disconnect()
    assert await adapter.connect()  # 재연결 시 _open이 flush → 안내 1건
    await wait_for(lambda: [p["body"] for p in _ok(server)] == [NOTICE_2])
    assert adapter._backlog == {}


async def test_concurrent_flush_posts_notice_once(server, make_adapter):
    import asyncio
    adapter = make_adapter()
    assert await adapter.connect()
    adapter._backlog = {DM_ID: 2}
    real_post = adapter._client.post_message

    async def slow_post(*args, **kwargs):
        await asyncio.sleep(0.05)
        return await real_post(*args, **kwargs)

    adapter._client.post_message = slow_post
    await asyncio.gather(adapter._flush_backlog(), adapter._flush_backlog())
    assert [p["body"] for p in _ok(server)] == [NOTICE_2]
    assert adapter._backlog == {}


async def test_partial_send_through_base_send_with_retry_posts_head_once(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    server.ok_posts_before_429 = 1  # 첫 청크만 게시, 두 번째 청크는 429 소진
    text = "d" * 4001
    head = _split(text)[0]
    res = await adapter._send_with_retry(chat_id=DM_ID, content=text)  # 실제 base 경로(재시도·plain fallback)
    assert not res.success
    assert res.raw_response["partial_overflow"] is True
    assert (res.raw_response["delivered_chunks"], res.raw_response["total_chunks"]) == (1, 2)
    assert [p["body"] for p in _ok(server)] == [head]  # 첫 청크 정확히 1회, fallback 재게시 없음
    assert {p["body"] for p in server.posts} <= set(_split(text))  # 429 시도 포함 plain-text fallback 시도 0
