"""F-3(FR-BOT-09): 모르는 대화 fail-closed — 송신 거부·get_chat_info 'unknown'·멘션 판정은 서버 mention_user_ids 리스트만."""

from __future__ import annotations

import pytest

from conftest import BOT_ID, BOT_NAME, CHANNEL_ID, DM_ID, OTHER_ID, make_message, wait_for

UNKNOWN_ID = "00000000-0000-0000-0000-0000000003e7"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


def _with_channel(server) -> None:
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]


async def _connected(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    return adapter


async def _sentinel(server, adapter) -> None:
    m = make_message(body="sentinel")
    await server.push_live(m)
    await wait_for(lambda: any(e.message_id == m["id"] for e in adapter.events))


def _assert_forbidden(res) -> None:
    assert res.success is False
    assert res.error_kind == "forbidden"
    assert res.retryable is False


# ---- 송신 거부 ----
async def test_FR_BOT_09_F3_unknown_conversation_send_refused(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    _assert_forbidden(await adapter.send(UNKNOWN_ID, "모르는 대화 최상위"))
    _assert_forbidden(await adapter.send(UNKNOWN_ID, "모르는 대화 스레드", metadata={"thread_id": DM_ID}))
    assert server.posts == []


async def test_FR_BOT_09_F3_unknown_conversation_attachment_refused(server, make_adapter, tmp_path):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF-1.4")
    img = tmp_path / "a.png"
    img.write_bytes(PNG)
    _assert_forbidden(await adapter.send_document(UNKNOWN_ID, str(doc), caption="문서"))  # 텍스트 대체 경로
    _assert_forbidden(await adapter.send_image_file(UNKNOWN_ID, str(img)))  # 업로드 경로
    _assert_forbidden(await adapter.send_image_file(UNKNOWN_ID, str(img), metadata={"thread_id": DM_ID}))
    assert server.posts == [] and server.uploads == []


async def test_FR_BOT_09_F3_dm_without_root_still_sends(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    res = await adapter.send(DM_ID, "DM 최상위")
    assert res.success is True
    posts = [p for p in server.posts if p["_status"] == 200]
    assert len(posts) == 1 and posts[0]["conversation_id"] == DM_ID
    assert posts[0].get("thread_root_id") is None


# ---- get_chat_info ----
async def test_FR_BOT_09_F3_get_chat_info_unknown_type(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    info = await adapter.get_chat_info(UNKNOWN_ID)
    assert info["type"] == "unknown"
    assert info["name"] == UNKNOWN_ID
    assert info["chat_id"] == UNKNOWN_ID
    assert (await adapter.get_chat_info(DM_ID))["name"] == BOT_NAME
    assert (await adapter.get_chat_info(CHANNEL_ID))["name"] == CHANNEL_ID


# ---- 멘션 판정: 리스트 외 모양·본문 사칭은 실행하지 않는다 ----
@pytest.mark.parametrize("mentions", [None, BOT_ID, {BOT_ID: True}], ids=["null", "str", "dict"])
async def test_FR_BOT_09_F3_malformed_mention_user_ids_not_executed(server, make_adapter, mentions):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(conv=CHANNEL_ID, body=f"@{BOT_NAME} 실행해줘")
    m["mention_user_ids"] = mentions
    await server.push_live(m, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert all(e.message_id != m["id"] for e in adapter.events)


@pytest.mark.parametrize("mentions", [[], [OTHER_ID]], ids=["empty", "other_only"])
async def test_FR_BOT_09_F3_body_only_bot_name_spoof_not_executed(server, make_adapter, mentions):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(conv=CHANNEL_ID, body=f"@{BOT_NAME}", mentions=mentions)
    await server.push_live(m, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert all(e.message_id != m["id"] for e in adapter.events)
