"""R3.3 봇 리스너 계약 회귀: 403 분리·sync `op`·WS 1008 종료 (TRD R3.3 §5-2, ADR-001 §3-f)."""

from __future__ import annotations

import logging
import time

from conftest import DM_ID, TOKEN, make_message, wait_for


def _posts_ok(server):
    return [p for p in server.posts if p["_status"] == 200]


def _save_cursor(tmp_path, change_id: int) -> None:
    from ohmyslack.cursor import CursorState, CursorStore
    CursorStore(tmp_path / "cursor.json").save(CursorState(change_id=change_id, saved_at=time.time()))


# ---------- 403: 그 동작만 실패, 인증 실패 아님 ----------
async def test_403_on_connect_is_not_fatal_and_next_connect_succeeds(server, make_adapter, tmp_path):
    _save_cursor(tmp_path, server.next_change)
    server.sync_403 = 1
    adapter = make_adapter()
    assert await adapter.connect() is False
    assert adapter.fatal_error_code is None
    assert await adapter.connect() is True


async def test_403_during_reconnect_keeps_retrying(server, make_adapter, fake_sleep):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    server.sync_403 = 1
    await server.drop_all()
    await wait_for(lambda: server.sockets)
    assert adapter.fatal_error_code is None
    assert not adapter._reader_task.done()
    assert fake_sleep.calls == [2, 4]


async def test_403_on_send_fails_only_that_send(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    server.post_status = [403]
    res = await adapter.send(DM_ID, "denied")
    assert res.success is False and "403" in (res.error or "")
    assert res.retryable is False
    assert len(server.posts) == 1  # 403은 재시도하지 않는다
    assert adapter.fatal_error_code is None
    assert (await adapter.send(DM_ID, "next")).success is True


# ---------- sync op ----------
async def test_sync_op_edit_is_not_run_even_without_edited_at(server, make_adapter, tmp_path):
    _save_cursor(tmp_path, server.next_change)
    edited = make_message(body="edit op without edited_at", age=30)
    server.add(edited, op="edit")
    adapter = make_adapter()
    assert await adapter.connect()
    assert adapter.events == []


async def test_sync_op_delete_is_not_run(server, make_adapter, tmp_path):
    _save_cursor(tmp_path, server.next_change)
    server.add(make_message(body="deleted", age=30), op="delete")
    adapter = make_adapter()
    assert await adapter.connect()
    assert adapter.events == []


async def test_sync_deleted_at_wins_over_op_create(server, make_adapter, tmp_path):
    # 서버가 삭제된 메시지에 op='create'를 싣는 경우가 관측됨 — 삭제 판정은 deleted_at 우선.
    _save_cursor(tmp_path, server.next_change)
    deleted = make_message(body="deleted but op create", age=30)
    deleted["deleted_at"] = deleted["created_at"]
    server.add(deleted, op="create")
    adapter = make_adapter()
    assert await adapter.connect()
    assert adapter.events == []


async def test_sync_op_create_root_in_same_page_as_reply_runs(server, make_adapter, tmp_path):
    _save_cursor(tmp_path, server.next_change)
    root = make_message(body="new root", age=30)
    reply = make_message(body="reply", age=20, thread_root_id=root["id"])
    server.page_size = 10
    server.add(root, op="create")
    server.add(reply, op="create")
    adapter = make_adapter()
    assert await adapter.connect()
    assert [e.message_id for e in adapter.events] == [root["id"], reply["id"]]


async def test_sync_op_edit_of_old_message_is_not_counted_as_backlog(server, make_adapter, tmp_path):
    _save_cursor(tmp_path, server.next_change)
    server.add(make_message(body="old edited", age=3 * 3600), op="edit")
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    assert adapter.events == [] and _posts_ok(server) == []


# ---------- WS close 코드 ----------
async def test_ws_close_1008_stops_reconnect_without_logging_token(server, make_adapter, fake_sleep, caplog):
    caplog.set_level(logging.DEBUG)
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    await server.close_all(1008, b"token_revoked")
    await wait_for(lambda: adapter._reader_task.done())
    assert adapter.fatal_error_code == "unauthorized"
    assert adapter.fatal_error_retryable is False
    assert fake_sleep.calls == []
    assert server.ws_connects == 1
    assert "1008" in caplog.text
    assert TOKEN not in caplog.text


async def test_ws_close_1001_reconnects(server, make_adapter, fake_sleep):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    await server.close_all(1001, b"server_shutdown")
    await wait_for(lambda: server.ws_connects == 2 and server.sockets)
    assert adapter.fatal_error_code is None
    assert fake_sleep.calls == [2]
