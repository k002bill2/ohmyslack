"""연결·재연결·catch-up·필터·세션 매핑 (ADR-001 §3-c·d·e·f, TRD §5-2)."""

from __future__ import annotations

import json
import logging
import time

import pytest

from conftest import BOT_ID, DM_ID, OTHER_ID, OWNER_ID, TOKEN, make_message, wait_for


def _posts_ok(server):
    return [p for p in server.posts if p["_status"] == 200]


async def test_connect_sends_bearer_without_origin_or_cookie(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect() is True
    await wait_for(lambda: server.sockets)
    paths = [path for _m, path, _h in server.requests]
    assert paths[0] == "/api/bot/v1/me"
    assert "/api/bot/v1/ws" in paths
    for _m, _p, headers in server.requests:
        lowered = {k.lower(): v for k, v in headers.items()}
        assert lowered["authorization"] == f"Bearer {TOKEN}"
        assert "origin" not in lowered
        assert "cookie" not in lowered


async def test_first_connect_without_cursor_uses_snapshot_and_runs_nothing(server, make_adapter, tmp_path):
    server.snapshot_messages = [make_message(body="old instruction", age=30)]
    adapter = make_adapter()
    assert await adapter.connect()
    assert any(p == "/api/bot/v1/sync/snapshot" for _m, p, _h in server.requests)
    assert adapter.events == []
    assert _posts_ok(server) == []  # 첫 연결은 안내도 없음
    saved = json.loads((tmp_path / "cursor.json").read_text())
    assert saved["change_id"] == server.next_change


async def test_reconnect_backoff_doubles_to_cap_with_jitter_bound(server, make_adapter, fake_sleep):
    from ohmyslack.adapter import backoff_delay
    assert [backoff_delay(i, lambda: 0.0) for i in range(7)] == [2, 4, 8, 16, 32, 60, 60]
    assert backoff_delay(10, lambda: 1.0) == pytest.approx(66.0)
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    server.ws_fail = 3
    await server.drop_all()
    await wait_for(lambda: server.sockets)
    assert fake_sleep.calls == [2, 4, 8, 16]
    assert server.ws_connects == 5


async def test_401_on_connect_is_fatal_without_retry(server, make_adapter, fake_sleep):
    server.me_status = 401
    adapter = make_adapter()
    assert await adapter.connect() is False
    assert adapter.fatal_error_code == "unauthorized"
    assert adapter.fatal_error_retryable is False
    assert len([r for r in server.requests if r[1] == "/api/bot/v1/me"]) == 1
    assert fake_sleep.calls == []


async def test_403_during_reconnect_stops_loop(server, make_adapter, fake_sleep):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    server.me_status = 403
    await server.drop_all()
    await wait_for(lambda: adapter.fatal_error_code == "unauthorized")
    await wait_for(lambda: adapter._reader_task.done())
    assert fake_sleep.calls == [2]


async def test_catch_up_after_60s_outage_no_loss_no_duplicates(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    live = make_message(body="live A")
    await server.push_live(live)
    await wait_for(lambda: len(adapter.events) == 1)
    await server.drop_all()  # 60초 단절 중 3건
    missed = [make_message(body=f"missed {i}", age=60) for i in range(3)]
    for m in missed:
        server.add(m)
    await wait_for(lambda: server.sockets and len(adapter.events) >= 4)
    await wait_for(lambda: server.sockets)
    ids = [e.message_id for e in adapter.events]
    assert ids == [live["id"]] + [m["id"] for m in missed]
    assert len(ids) == len(set(ids))


async def test_restart_does_not_rerun_processed_messages(server, make_adapter, tmp_path):
    first = make_adapter()
    assert await first.connect()
    await wait_for(lambda: server.sockets)
    m = make_message(body="run once")
    await server.push_live(m)
    await wait_for(lambda: len(first.events) == 1)
    await first.disconnect()
    second = make_adapter()  # 같은 cursor 파일, 새 프로세스 가정
    assert await second.connect()
    await wait_for(lambda: server.sockets)
    assert second.events == []


async def test_410_recovers_via_snapshot_and_posts_one_notice(server, make_adapter, tmp_path):
    from ohmyslack.cursor import CursorState, CursorStore
    CursorStore(tmp_path / "cursor.json").save(CursorState(change_id=1, saved_at=time.time() - 3600))
    server.sync_expired_below = 5
    server.snapshot_messages = [make_message(body="while offline 1", age=1800),
                                make_message(body="while offline 2", age=1200),
                                make_message(author=OTHER_ID, body="not owner", age=1200),
                                make_message(body="before offline", age=7200)]
    after_snapshot = make_message(body="fresh after snapshot")
    adapter = make_adapter()
    server.next_change = 20
    server.add(after_snapshot)
    server.next_change = 20  # snapshot_cursor=20 → 21번 변경은 catch-up 대상
    server.changes[-1] = (21, DM_ID, after_snapshot)
    assert await adapter.connect()
    assert [e.message_id for e in adapter.events] == [after_snapshot["id"]]
    notices = [p["body"] for p in _posts_ok(server)]
    assert notices == ["오프라인 동안 받은 2건은 처리하지 않았습니다"]


async def test_backlog_older_than_15_minutes_not_run_one_notice(server, make_adapter, tmp_path):
    from ohmyslack.cursor import CursorState, CursorStore
    CursorStore(tmp_path / "cursor.json").save(CursorState(change_id=server.next_change, saved_at=time.time()))
    old = [make_message(body="rm -rf old", age=16 * 60), make_message(body="old 2", age=60 * 60)]
    fresh = make_message(body="fresh", age=14 * 60)
    for m in old + [fresh]:
        server.add(m)
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    assert [e.message_id for e in adapter.events] == [fresh["id"]]
    ok = _posts_ok(server)
    assert [p["body"] for p in ok] == ["오프라인 동안 받은 2건은 처리하지 않았습니다"]
    assert "thread_root_id" not in ok[0]  # 최상위 안내


async def test_live_ws_replay_of_old_message_also_capped(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    await server.push_live(make_message(body="stale replay", age=20 * 60))
    await server.push_live(make_message(body="marker"))
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].text == "marker"


async def test_filters_self_echo_non_owner_and_duplicates(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    owner = make_message(body="do it")
    await server.push_live(make_message(author=BOT_ID, body="echo"))
    await server.push_live(make_message(author=OTHER_ID, body="do it"))  # 본문이 같아도 author로만 판정
    await server.push_live(owner)
    await server.push_live(owner)  # 재전달
    await server.push_live(make_message(body="end"))
    await wait_for(lambda: len(adapter.events) == 2)
    assert [e.text for e in adapter.events] == ["do it", "end"]
    assert adapter.events[0].message_id == owner["id"]


async def test_approve_text_passes_through_and_non_owner_approve_ignored(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    await server.push_live(make_message(author=OTHER_ID, body="/approve"))
    await server.push_live(make_message(body="/approve"))
    await server.push_live(make_message(body="/deny"))
    await wait_for(lambda: len(adapter.events) == 2)
    assert [e.text for e in adapter.events] == ["/approve", "/deny"]
    assert all(e.user_id == OWNER_ID for e in adapter.events)


async def test_top_level_new_session_reply_same_session(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    root = make_message(body="top")
    reply = make_message(body="reply", thread_root_id=root["id"])
    other_root = make_message(body="another top")
    for m in (root, reply, other_root):
        await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == 3)
    threads = [e.source.thread_id for e in adapter.events]
    assert threads == [root["id"], root["id"], other_root["id"]]
    assert all(e.source.chat_id == DM_ID for e in adapter.events)


async def test_non_loopback_url_rejected(make_adapter):
    from ohmyslack.client import validate_bot_url
    for bad in ("http://10.0.0.5:8788", "https://127.0.0.1:8788", "http://example.com:80",
                "http://user:pw@127.0.0.1:8788", "http://127.0.0.1", "http://127.0.0.1.evil.com:1",
                "http://127.0.0.1:8788/api", "ws://127.0.0.1:8788"):
        with pytest.raises(ValueError):
            validate_bot_url(bad)
    assert validate_bot_url("http://localhost:8788/") == "http://localhost:8788"
    adapter = make_adapter(url="http://192.168.0.10:8788")
    assert await adapter.connect() is False
    assert adapter.fatal_error_code == "config_invalid"


async def test_token_and_body_never_logged(server, make_adapter, caplog):
    caplog.set_level(logging.DEBUG)
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    await server.push_live(make_message(body="secret-instruction-body"))
    await wait_for(lambda: len(adapter.events) == 1)
    server.post_429 = 1
    await adapter.send(DM_ID, "secret-reply-body")
    await adapter.send_document(DM_ID, "/private/secret-path.pdf", caption="cap")
    server.me_status = 401
    await server.drop_all()
    await wait_for(lambda: adapter.fatal_error_code == "unauthorized")
    for needle in (TOKEN, "secret-instruction-body", "secret-reply-body", "secret-path"):
        assert needle not in caplog.text
    assert "send_document is not supported" in caplog.text
