"""채널 참여: 대화 종류·멘션 게이팅·토큰 제거·세션 키·송신·멤버십 변화 (BOT_CHANNEL_SPEC §5, §5-9 케이스 1–8)."""

from __future__ import annotations

import pytest

from conftest import (BOT_ID, BOT_NAME, CHANNEL_ID, DM_ID, OTHER_ID, TOKEN, make_message, wait_for)

UNKNOWN_ID = "00000000-0000-0000-0000-0000000003e7"


def _posts_ok(server):
    return [p for p in server.posts if p["_status"] == 200]


def _with_channel(server) -> None:
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]


def _ch(body: str, *, mention: bool = True, **kw) -> dict:
    return make_message(conv=CHANNEL_ID, body=body, mentions=[BOT_ID] if mention else [], **kw)


async def _connected(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    return adapter


async def _sentinel(server, adapter) -> None:
    """DM 지시 1건을 흘려 보내고 처리될 때까지 기다린다 — 앞선 프레임이 모두 처리됐다는 표시."""
    m = make_message(body="sentinel")
    await server.push_live(m)
    await wait_for(lambda: any(e.message_id == m["id"] for e in adapter.events))


# ---- 케이스 1: chat_type·세션 ----
async def test_case1_channel_mention_top_level_new_session_reply_same_session(server, make_adapter):
    from gateway.session import build_session_key
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 요약해줘")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    reply = _ch(f"@{BOT_NAME} 더 자세히", thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    other_root = _ch(f"@{BOT_NAME} 다른 주제")
    await server.push_live(other_root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 3)
    e_root, e_reply, e_other = adapter.events
    assert e_root.source.chat_type == "channel"
    assert e_root.source.chat_id == CHANNEL_ID
    assert e_root.source.thread_id == root["id"]
    assert e_reply.source.thread_id == root["id"]
    assert e_root.text == "요약해줘"
    k_root, k_reply, k_other = (build_session_key(e.source) for e in adapter.events)
    assert ":ohmyslack:channel:" in k_root
    assert k_root.endswith(f"{CHANNEL_ID}:{root['id']}")
    assert k_root == k_reply
    assert k_other != k_root


async def test_case1_dm_still_dm_chat_type_and_body_untouched(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(body=f"@{BOT_NAME} /approve")  # DM: 게이팅·토큰 제거 없음(기존 동작)
    await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].source.chat_type == "dm"
    assert adapter.events[0].text == f"@{BOT_NAME} /approve"


# ---- 케이스 2: owner 비멘션 → 무시·백로그 0 (봇 스레드 답글은 예외, Q5 변경 2026-11-13) ----
async def test_case2_channel_owner_without_mention_ignored_and_not_counted(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 시작")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    plain = _ch("멘션 없는 최상위", mention=False)
    text_only = _ch(f"@{BOT_NAME} 본문에만 이름", mention=False)  # 판정은 서버 mention_user_ids만
    for m in (plain, text_only):
        await server.push_live(m, CHANNEL_ID)
    await server.drop_all()
    stale = _ch("오래된 비멘션", mention=False, age=16 * 60)
    server.add(stale, CHANNEL_ID)
    await wait_for(lambda: server.sockets)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == [root["id"]]
    assert adapter._backlog == {}
    assert _posts_ok(server) == []
    for m in (plain, text_only, stale):
        assert m["id"] in adapter._recent  # 게이팅 탈락은 dedupe에 기록만(§5-7)


async def test_case2_bot_thread_owner_reply_without_mention_continues_same_session(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 시작")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    reply = _ch("멘션 없는 답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 2)
    event = adapter.events[1]
    assert event.message_id == reply["id"]
    assert event.source.thread_id == root["id"]
    assert event.text == "멘션 없는 답글"
    assert server.replies_calls == []  # 이번 프로세스에서 넘긴 루트는 조회 없이 통과


async def test_thread_follow_non_bot_thread_reply_ignored(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch("봇 없는 대화", mention=False)
    await server.push_live(root, CHANNEL_ID)
    reply = _ch("그 스레드의 답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []
    assert reply["id"] in adapter._recent


async def test_thread_follow_non_owner_reply_in_bot_thread_ignored(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 시작")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    other = make_message(author=OTHER_ID, conv=CHANNEL_ID, body="끼어들기", thread_root_id=root["id"])
    await server.push_live(other, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == [root["id"]]


async def test_thread_follow_reply_mentioning_only_other_user_ignored(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 시작")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    to_other = make_message(conv=CHANNEL_ID, body="@민수 확인해줘", mentions=[OTHER_ID],
                            thread_root_id=root["id"])
    await server.push_live(to_other, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == [root["id"]]
    assert to_other["id"] in adapter._recent


async def test_thread_follow_after_restart_resolves_root_via_replies(server, make_adapter):
    _with_channel(server)
    root = _ch(f"@{BOT_NAME} 재시작 전 지시")
    server.add(root, CHANNEL_ID)  # 새 어댑터 인스턴스는 이 루트를 처리한 기억이 없다
    adapter = await _connected(server, make_adapter)
    reply = _ch("재시작 뒤 답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].message_id == reply["id"]
    assert adapter.events[0].source.thread_id == root["id"]
    reply2 = _ch("두 번째 답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply2, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 2)
    assert server.replies_calls == [root["id"]]  # 확인된 루트는 집합에 들어가 재조회 없음


async def test_thread_follow_restart_root_not_mentioning_bot_rejected(server, make_adapter):
    _with_channel(server)
    root = _ch("봇 멘션 없는 루트", mention=False)
    server.add(root, CHANNEL_ID)
    adapter = await _connected(server, make_adapter)
    reply = _ch("답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []
    assert server.replies_calls == [root["id"]]


@pytest.mark.parametrize("status", [404, 500])
async def test_thread_follow_replies_lookup_failure_fails_closed_and_is_cached(server, make_adapter, status):
    _with_channel(server)
    server.replies_status = status
    adapter = await _connected(server, make_adapter)
    root_id = "00000000-0000-0000-0000-0000000004d2"
    first = _ch("답글 1", mention=False, thread_root_id=root_id)
    second = _ch("답글 2", mention=False, thread_root_id=root_id)
    await server.push_live(first, CHANNEL_ID)
    await server.push_live(second, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []
    assert server.replies_calls == [root_id]  # 음성·오류도 짧게 캐시 → 같은 루트 재조회 억제


async def test_thread_follow_edited_reply_without_mention_not_executed(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 시작")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    edited = _ch("수정된 답글", mention=False, thread_root_id=root["id"])
    edited["edited_at"] = edited["created_at"]
    await server.push_live(edited, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == [root["id"]]


# ---- 케이스 3: 비owner 멘션 → 무시 ----
async def test_case3_channel_non_owner_mention_ignored(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(author=OTHER_ID, conv=CHANNEL_ID, body=f"@{BOT_NAME} 비밀 알려줘", mentions=[BOT_ID])
    await server.push_live(m, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []
    assert _posts_ok(server) == []


# ---- 케이스 4: 토큰 제거 후 승인 해석 ----
async def test_case4_channel_approve_reply_strips_leading_token(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    root = _ch(f"@{BOT_NAME} 배포해줘")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    approve = _ch(f"  @{BOT_NAME}   /approve  ", thread_root_id=root["id"])
    await server.push_live(approve, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 2)
    event = adapter.events[1]
    assert event.text == "/approve"
    assert event.get_command() == "approve"
    assert event.source.thread_id == root["id"]


def test_case4_strip_only_first_leading_token_with_word_boundary():
    from ohmyslack.adapter import strip_mention_token
    assert strip_mention_token("@Jarvis /approve", "Jarvis") == "/approve"
    assert strip_mention_token("@Jarvis @Jarvis hi", "Jarvis") == "@Jarvis hi"
    assert strip_mention_token("@Jarvis님 안녕", "Jarvis") == "@Jarvis님 안녕"
    assert strip_mention_token("@Jarvis, 요약", "Jarvis") == ", 요약"
    assert strip_mention_token("요약 @Jarvis", "Jarvis") == "요약 @Jarvis"
    assert strip_mention_token("@Jarvis", "Jarvis") == ""
    assert strip_mention_token(" hi ", "") == "hi"
    assert strip_mention_token("@J.a /x", "J.a") == "/x"


# ---- §5-1 S8·결정 8 ----
async def test_unknown_conversation_message_ignored(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(conv=UNKNOWN_ID, body=f"@{BOT_NAME} hi", mentions=[BOT_ID])
    await server.push_live(m, UNKNOWN_ID)
    await _sentinel(server, adapter)
    assert all(e.source.chat_id != UNKNOWN_ID for e in adapter.events)


async def test_channel_mention_added_by_edit_is_not_executed(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    await server.drop_all()
    # sync는 현재 행 projection을 싣는다: create 변경이어도 이미 수정돼 멘션이 붙은 값일 수 있다.
    edited = _ch(f"@{BOT_NAME} 나중에 붙은 멘션")
    edited["edited_at"] = edited["created_at"]
    server.add(edited, CHANNEL_ID, op="create")
    await wait_for(lambda: server.sockets)
    await _sentinel(server, adapter)
    assert all(e.message_id != edited["id"] for e in adapter.events)


async def test_get_chat_info_reports_real_kind(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    assert (await adapter.get_chat_info(CHANNEL_ID))["type"] == "channel"
    assert (await adapter.get_chat_info(DM_ID))["type"] == "dm"


async def test_me_without_conversations_fails_connect(server, make_adapter):
    server.conversations = None  # type: ignore[assignment] — 구 서버 모양(/me에 conversations 없음)
    adapter = make_adapter()
    assert await adapter.connect() is False



# ---- 케이스 5: 멤버십 변화 ----
def _me_calls(server) -> int:
    return sum(1 for _m, p, _h in server.requests if p == "/api/bot/v1/me")


async def test_case5_joined_subscribes_without_reconnect_then_left_ignores(server, make_adapter):
    adapter = await _connected(server, make_adapter)  # DM만 참여 상태로 시작
    me_before = _me_calls(server)
    _with_channel(server)
    await server.send_frame({"type": "membership.changed", "conversation_id": CHANNEL_ID, "state": "joined"})
    await wait_for(lambda: any(cid == CHANNEL_ID for cid, _a in server.subscribed))
    assert server.ws_connects == 1  # 재연결 없음
    assert _me_calls(server) == me_before + 1
    assert [(cid, after) for cid, after in server.subscribed if cid == CHANNEL_ID] == [(CHANNEL_ID, adapter._watermark)]
    first = _ch(f"@{BOT_NAME} 참여 후 첫 지시")
    await server.push_live(first, CHANNEL_ID)
    await wait_for(lambda: any(e.message_id == first["id"] for e in adapter.events))

    server.conversations = [{"id": DM_ID, "kind": "dm"}]
    await server.send_frame({"type": "membership.changed", "conversation_id": CHANNEL_ID, "state": "left"})
    after_left = _ch(f"@{BOT_NAME} 제거 후")
    await server.push_live(after_left, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert all(e.message_id != after_left["id"] for e in adapter.events)
    assert CHANNEL_ID not in adapter._conversation_ids


async def test_case5_error_not_found_removes_conversation(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    server.conversations = [{"id": DM_ID, "kind": "dm"}]  # 서버에서 멤버십 종료
    await server.send_frame({"type": "error", "code": "not_found", "retryable": False,
                             "conversation_id": CHANNEL_ID})
    later = _ch(f"@{BOT_NAME} not_found 뒤")
    await server.push_live(later, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert all(e.message_id != later["id"] for e in adapter.events)
    assert adapter._conversation_ids == (DM_ID,)


async def test_case5_joined_unconfirmed_by_me_does_not_subscribe(server, make_adapter):
    adapter = await _connected(server, make_adapter)
    await server.send_frame({"type": "membership.changed", "conversation_id": CHANNEL_ID, "state": "joined"})
    await _sentinel(server, adapter)
    assert all(cid != CHANNEL_ID for cid, _a in server.subscribed)  # /me에 없으면 구독하지 않음


async def test_sync_required_refetches_me_before_resubscribe(server, make_adapter):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    await wait_for(lambda: len(server.subscribed) == 2)
    me_before = _me_calls(server)
    server.conversations = [{"id": DM_ID, "kind": "dm"}]  # 그 사이 채널에서 제거됨(left 프레임 유실 가정)
    await server.send_frame({"type": "sync.required"})
    await wait_for(lambda: len(server.subscribed) == 3)
    await _sentinel(server, adapter)
    assert _me_calls(server) == me_before + 1
    assert server.subscribed[2][0] == DM_ID
    assert len(server.subscribed) == 3  # 채널은 다시 구독하지 않음


# ---- 케이스 6: 채널 루트 없는 송신 ----
async def test_case6_channel_send_without_root_is_refused(server, make_adapter, tmp_path):
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    res = await adapter.send(CHANNEL_ID, "최상위로 쓰면 안 됨")
    assert res.success is False and res.retryable is False
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)
    res_img = await adapter.send_image_file(CHANNEL_ID, str(img))
    assert res_img.success is False
    assert server.posts == [] and server.uploads == []
    root = _ch(f"@{BOT_NAME} 질문")
    await server.push_live(root, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    ok = await adapter.send(CHANNEL_ID, "스레드 답글", metadata={"thread_id": root["id"]})
    assert ok.success is True
    assert _posts_ok(server)[-1]["thread_root_id"] == root["id"]
    dm = await adapter.send(DM_ID, "DM 최상위는 그대로")
    assert dm.success is True and _posts_ok(server)[-1].get("thread_root_id") is None


async def test_case6_standalone_refuses_channel_home(server):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import standalone_send
    _with_channel(server)
    cfg = PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})
    out = await standalone_send(cfg, CHANNEL_ID, "브리핑")
    assert "error" in out and server.posts == []


# ---- 케이스 7: 15분 넘은 채널 멘션 → 실행 0, 안내는 DM으로 1회 ----
async def test_case7_stale_channel_mention_notice_goes_to_dm_once(server, make_adapter):
    from ohmyslack.adapter import BACKLOG_NOTICE
    _with_channel(server)
    adapter = await _connected(server, make_adapter)
    await server.drop_all()
    stale = [_ch(f"@{BOT_NAME} 오래된 지시 {i}", age=16 * 60) for i in range(2)]
    for m in stale:
        server.add(m, CHANNEL_ID)
    server.add(_ch("오래된 비멘션", mention=False, age=16 * 60), CHANNEL_ID)
    await wait_for(lambda: server.sockets and _posts_ok(server))
    await _sentinel(server, adapter)
    assert all(e.source.chat_id != CHANNEL_ID for e in adapter.events)
    posts = _posts_ok(server)
    assert len(posts) == 1
    assert posts[0]["conversation_id"] == DM_ID
    assert posts[0].get("thread_root_id") is None
    assert posts[0]["body"] == f"{BACKLOG_NOTICE.format(n=2)} ({CHANNEL_ID})"


async def test_case5_join_racing_catch_up_does_not_drop_first_mention(server, make_adapter):
    # Codex P2: joined 프레임 처리 전에 REST catch-up이 새 채널 변경을 실으면 /me를 다시 읽고 처리해야 한다.
    adapter = await _connected(server, make_adapter)  # DM만
    _with_channel(server)
    first = _ch(f"@{BOT_NAME} 참여 직후 지시")
    server.add(first, CHANNEL_ID)
    await _sentinel(server, adapter)  # DM live → catch-up이 채널 변경을 싣는다
    await wait_for(lambda: any(e.message_id == first["id"] for e in adapter.events))
    await server.send_frame({"type": "membership.changed", "conversation_id": CHANNEL_ID, "state": "joined"})
    await wait_for(lambda: any(cid == CHANNEL_ID for cid, _a in server.subscribed))
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events].count(first["id"]) == 1


# ---- 채널 이름 → SessionSource.chat_name (channel-name-me) ----
CHANNEL_NAME = "proj-ohmyslack"


def _with_named_channel(server) -> None:
    server.conversations = [{"id": DM_ID, "kind": "dm", "name": None},
                            {"id": CHANNEL_ID, "kind": "channel", "name": CHANNEL_NAME}]


async def test_channel_ingest_sets_chat_name_from_me(server, make_adapter):
    _with_named_channel(server)
    adapter = await _connected(server, make_adapter)
    m = _ch(f"@{BOT_NAME} 이름 확인")
    await server.push_live(m, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].source.chat_name == CHANNEL_NAME
    assert adapter.events[0].source.chat_id == CHANNEL_ID


async def test_dm_ingest_has_no_chat_name(server, make_adapter):
    _with_named_channel(server)
    adapter = await _connected(server, make_adapter)
    m = make_message(body="DM 지시")
    await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].source.chat_type == "dm"
    assert adapter.events[0].source.chat_name is None


async def test_me_without_name_keeps_previous_behavior(server, make_adapter):
    _with_channel(server)  # 구 서버: conversations[]에 name 없음
    adapter = await _connected(server, make_adapter)
    m = _ch(f"@{BOT_NAME} 이름 없음")
    await server.push_live(m, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].source.chat_type == "channel"
    assert adapter.events[0].source.chat_name is None
    assert (await adapter.get_chat_info(CHANNEL_ID))["name"] == CHANNEL_ID


async def test_non_string_name_ignored(server, make_adapter):
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel", "name": 42}]
    adapter = await _connected(server, make_adapter)
    m = _ch(f"@{BOT_NAME} 이상한 이름")
    await server.push_live(m, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].source.chat_name is None


async def test_get_chat_info_uses_channel_name(server, make_adapter):
    _with_named_channel(server)
    adapter = await _connected(server, make_adapter)
    assert (await adapter.get_chat_info(CHANNEL_ID))["name"] == CHANNEL_NAME
    assert (await adapter.get_chat_info(DM_ID))["name"] == "Jarvis"


async def test_left_channel_forgets_name(server, make_adapter):
    _with_named_channel(server)
    adapter = await _connected(server, make_adapter)
    assert (await adapter.get_chat_info(CHANNEL_ID))["name"] == CHANNEL_NAME
    server.conversations = [{"id": DM_ID, "kind": "dm", "name": None}]
    await server.send_frame({"type": "membership.changed", "conversation_id": CHANNEL_ID, "state": "left"})
    await _sentinel(server, adapter)
    assert CHANNEL_ID not in adapter._conversation_ids
    assert (await adapter.get_chat_info(CHANNEL_ID))["name"] == CHANNEL_ID


# ---- 브리핑 채널 allowlist(OHMYSLACK_POST_CHANNELS, 2026-11-19 영환님 지시 — BOT_CHANNEL_SPEC §5-5·§5-6 예외) ----
POST_CHANNELS_ENV = "OHMYSLACK_POST_CHANNELS"
OTHER_CHANNEL_ID = "00000000-0000-0000-0000-0000000000c9"


def _with_two_channels(server) -> None:
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"},
                            {"id": OTHER_CHANNEL_ID, "kind": "channel"}]


async def test_post_channels_unset_still_refuses_channel_top_level(server, make_adapter):
    _with_two_channels(server)
    adapter = await _connected(server, make_adapter)
    res = await adapter.send(CHANNEL_ID, "브리핑")
    assert res.success is False and res.error_kind == "forbidden"
    assert server.posts == []


async def test_post_channels_allowlisted_channel_allows_top_level(server, make_adapter, monkeypatch, tmp_path):
    monkeypatch.setenv(POST_CHANNELS_ENV, f" {CHANNEL_ID} ,, not-a-uuid ")
    _with_two_channels(server)
    adapter = await _connected(server, make_adapter)
    res = await adapter.send(CHANNEL_ID, "아침 브리핑")
    assert res.success is True
    assert _posts_ok(server)[-1]["conversation_id"] == CHANNEL_ID
    assert _posts_ok(server)[-1].get("thread_root_id") is None
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
                    + b"\x00" * 32)  # test_attachments.py PNG과 같은 바이트(업로드 성공 경로)
    assert (await adapter.send_image_file(CHANNEL_ID, str(img))).success is True
    other = await adapter.send(OTHER_CHANNEL_ID, "allowlist 밖")
    assert other.success is False and other.error_kind == "forbidden"
    assert all(p.get("conversation_id") != OTHER_CHANNEL_ID for p in server.posts)


async def test_post_channels_standalone_allows_allowlisted_channel_only(server, monkeypatch):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import standalone_send
    monkeypatch.setenv(POST_CHANNELS_ENV, CHANNEL_ID)
    _with_two_channels(server)
    cfg = PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})
    out = await standalone_send(cfg, CHANNEL_ID, "브리핑")
    assert out.get("success") is True
    assert _posts_ok(server)[-1]["conversation_id"] == CHANNEL_ID
    refused = await standalone_send(cfg, OTHER_CHANNEL_ID, "브리핑")
    assert "error" in refused
    assert all(p.get("conversation_id") != OTHER_CHANNEL_ID for p in server.posts)


async def test_post_channels_unset_standalone_refuses_channel(server):
    from gateway.config import PlatformConfig
    from ohmyslack.adapter import standalone_send
    _with_two_channels(server)
    cfg = PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})
    out = await standalone_send(cfg, CHANNEL_ID, "브리핑")
    assert "error" in out and server.posts == []


def _bot_root(conv: str) -> dict:
    return make_message(author=BOT_ID, conv=conv, body="오늘의 브리핑")


async def test_post_channels_owner_reply_to_bot_root_follows_thread(server, make_adapter, monkeypatch):
    monkeypatch.setenv(POST_CHANNELS_ENV, CHANNEL_ID)
    _with_two_channels(server)
    root = _bot_root(CHANNEL_ID)
    server.add(root, CHANNEL_ID)
    adapter = await _connected(server, make_adapter)
    reply = _ch("이거 더 알려줘", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await wait_for(lambda: len(adapter.events) == 1)
    assert adapter.events[0].message_id == reply["id"]
    assert adapter.events[0].source.thread_id == root["id"]
    assert server.replies_calls == [root["id"]]


async def test_post_channels_bot_root_outside_allowlist_rejected(server, make_adapter, monkeypatch):
    monkeypatch.setenv(POST_CHANNELS_ENV, CHANNEL_ID)
    _with_two_channels(server)
    root = _bot_root(OTHER_CHANNEL_ID)
    server.add(root, OTHER_CHANNEL_ID)
    adapter = await _connected(server, make_adapter)
    reply = make_message(conv=OTHER_CHANNEL_ID, body="답글", thread_root_id=root["id"])
    await server.push_live(reply, OTHER_CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == OTHER_CHANNEL_ID] == []


async def test_post_channels_bot_root_without_allowlist_rejected(server, make_adapter):
    _with_two_channels(server)
    root = _bot_root(CHANNEL_ID)
    server.add(root, CHANNEL_ID)
    adapter = await _connected(server, make_adapter)
    reply = _ch("답글", mention=False, thread_root_id=root["id"])
    await server.push_live(reply, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []


async def test_post_channels_non_owner_reply_to_bot_root_rejected(server, make_adapter, monkeypatch):
    monkeypatch.setenv(POST_CHANNELS_ENV, CHANNEL_ID)
    _with_two_channels(server)
    root = _bot_root(CHANNEL_ID)
    server.add(root, CHANNEL_ID)
    adapter = await _connected(server, make_adapter)
    other = make_message(author=OTHER_ID, conv=CHANNEL_ID, body="끼어들기", thread_root_id=root["id"])
    await server.push_live(other, CHANNEL_ID)
    await _sentinel(server, adapter)
    assert [e.message_id for e in adapter.events if e.source.chat_id == CHANNEL_ID] == []
