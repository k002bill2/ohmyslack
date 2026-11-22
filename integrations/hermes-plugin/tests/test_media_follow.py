"""#52 live 경로 후속 첨부: allowlist 채널에서 caption 없는 첨부가 창(60초) 안 유일한 최상위 본문 뒤에 오면
그 본문 첫 조각 스레드에 붙는다. 모호·창 초과·caption·루트 지정·DM·allowlist 밖은 기존 동작.
#57: 창 판정은 단조 시계(`_window_clock`) — 벽시계(`_clock`) 역행·전진에 영향받지 않는다."""

from __future__ import annotations

import logging

import pytest

from conftest import BOT_ID, CHANNEL_ID, DM_ID, FakeClock, make_message, wait_for

POST_CHANNELS_ENV = "OHMYSLACK_POST_CHANNELS"
OTHER_CHANNEL_ID = "00000000-0000-0000-0000-0000000000c9"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64  # test_attachments.py와 같은 바이트
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       + b"\x00" * 32)


# ---- test_channel.py 헬퍼 최소 복제(테스트 모듈끼리 import하지 않는다) ----
def _with_two_channels(server) -> None:
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"},
                            {"id": OTHER_CHANNEL_ID, "kind": "channel"}]


def _posts_ok(server):
    return [p for p in server.posts if p["_status"] == 200]


def _posted_ids(server) -> list[str]:
    return [m["id"] for _c, _conv, m in server.changes if m.get("author_id") == BOT_ID]


def _long_body(n: int = 9000) -> str:
    unit = "가나다라마바사아자차카타파하abc123"
    return (unit * (n // len(unit) + 1))[:n]


async def _connected(server, make_adapter, monkeypatch, *, allowlist: bool = True):
    if allowlist:
        monkeypatch.setenv(POST_CHANNELS_ENV, CHANNEL_ID)
    _with_two_channels(server)
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    clock = FakeClock()
    # make_adapter가 시계를 받지 않아 연결 뒤 주입. 창 판정은 단조 `_window_clock`만 쓴다(#57). 벽시계 `_clock`은 그대로.
    adapter._window_clock = clock
    return adapter, clock


def _file(tmp_path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _top_level(posts) -> list[dict]:
    return [p for p in posts if p.get("thread_root_id") is None]


# 1
async def test_long_text_then_voice_follows_first_chunk_thread(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    res = await adapter.send(CHANNEL_ID, _long_body())
    assert res.success is True
    n_text = len(_posts_ok(server))
    assert n_text >= 3
    voice = await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "briefing.mp3", MP3))
    assert voice.success is True
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == n_text + 1 and len(ids) == len(ok)
    mp3 = ok[-1]
    assert mp3["thread_root_id"] == ids[0]
    assert mp3.get("attachment_ids") == [server.uploads[0]["attachment_id"]]
    assert len(_top_level(ok)) == 1
    assert res.message_id == ids[n_text - 1]  # send() 반환값은 그대로 마지막 조각


# 2
async def test_short_text_then_voice_follows_thread(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 2
    assert ok[0].get("thread_root_id") is None
    assert ok[1]["thread_root_id"] == ids[0] and ok[1].get("attachment_ids")


# 3
async def test_text_then_voice_and_image_share_thread(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    assert (await adapter.send_image_file(CHANNEL_ID, _file(tmp_path, "c.png", PNG))).success is True
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 3
    assert len(_top_level(ok)) == 1
    assert ok[1]["thread_root_id"] == ids[0] and ok[2]["thread_root_id"] == ids[0]
    assert all(p.get("attachment_ids") for p in ok[1:])


# 4
async def test_window_exceeded_keeps_top_level(server, make_adapter, monkeypatch, tmp_path):
    adapter, clock = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    clock.now += 61
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    assert len(ok) == 2 and len(_top_level(ok)) == 2


# 5
async def test_two_recent_texts_ambiguous_keeps_top_level(server, make_adapter, monkeypatch, tmp_path, caplog):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "브리핑 1")).success is True
    assert (await adapter.send(CHANNEL_ID, "브리핑 2")).success is True
    with caplog.at_level(logging.WARNING, logger="ohmyslack.adapter"):
        assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    assert len(ok) == 3 and len(_top_level(ok)) == 3
    msgs = [r.getMessage() for r in caplog.records if "attachment follow skipped" in r.getMessage()]
    assert msgs == ["ohmyslack: attachment follow skipped (ambiguous recent top-level posts)"]


# 6
async def test_voice_with_caption_does_not_follow(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3), caption="음성")).success is True
    ok = _posts_ok(server)
    assert len(ok) == 2 and len(_top_level(ok)) == 2
    assert ok[1]["body"] == "음성"


# 7
@pytest.mark.parametrize("via", ["reply_to", "metadata"])
async def test_explicit_root_is_kept(server, make_adapter, monkeypatch, tmp_path, via):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    root = make_message(conv=CHANNEL_ID, body="스레드 루트", mentions=[BOT_ID])
    server.add(root, CHANNEL_ID)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    kw = {"reply_to": root["id"]} if via == "reply_to" else {"metadata": {"thread_id": root["id"]}}
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3), **kw)).success is True
    ok = _posts_ok(server)
    assert len(ok) == 2
    assert ok[1]["thread_root_id"] == root["id"]


# 8
async def test_dm_text_then_voice_both_top_level(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(DM_ID, "아침 브리핑")).success is True
    assert (await adapter.send_voice(DM_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    assert len(ok) == 2 and len(_top_level(ok)) == 2
    assert adapter._top_posts == {}  # DM은 기록하지 않는다


# 9
async def test_outside_allowlist_rootless_voice_still_refused(server, make_adapter, monkeypatch, tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    root = make_message(author=BOT_ID, conv=OTHER_CHANNEL_ID, body="루트")
    server.add(root, OTHER_CHANNEL_ID)
    assert (await adapter.send(OTHER_CHANNEL_ID, "답글", reply_to=root["id"])).success is True
    n = len(server.posts)
    res = await adapter.send_voice(OTHER_CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))
    assert res.success is False and res.error_kind == "forbidden"
    assert server.uploads == [] and len(server.posts) == n


# 10
async def test_rejected_file_fallback_lands_in_text_thread(server, make_adapter, monkeypatch, tmp_path):
    from ohmyslack.adapter import ATTACHMENT_FALLBACK
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    res = await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "voice.ogg", MP3))  # 확장자 불허 → 대체 글
    assert res.success is True
    assert server.uploads == []
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 2
    assert ok[1]["thread_root_id"] == ids[0]
    assert ok[1]["body"] == ATTACHMENT_FALLBACK and "attachment_ids" not in ok[1]


# 11
async def test_top_level_attachment_is_recorded_as_media_and_not_followed(server, make_adapter, monkeypatch,
                                                                          tmp_path):
    adapter, clock = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    clock.now += 61
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True  # 최상위 → media
    assert (await adapter.send_image_file(CHANNEL_ID, _file(tmp_path, "c.png", PNG))).success is True
    ok = _posts_ok(server)
    assert len(ok) == 3 and len(_top_level(ok)) == 3
    assert [e[2] for e in adapter._top_posts[CHANNEL_ID]] == ["media", "media"]


# 12 (#57 a) 창 판정은 단조 시계만 본다: 벽시계가 뒤로/앞으로 뛰어도 창 판정은 `_window_clock` 경과로 정한다.
@pytest.mark.parametrize("wall_jump, window_advance, follows", [
    (-3600.0, 61.0, False),  # 벽시계 역행 + 단조 61초 → 창 밖(수정 전: now - t 음수로 창 안에 남아 따라붙음)
    (3600.0, 1.0, True),  # 벽시계 전진 + 단조 1초 → 창 안
])
async def test_window_uses_monotonic_clock_not_wall_clock(server, make_adapter, monkeypatch, tmp_path,
                                                         wall_jump, window_advance, follows):
    adapter, clock = await _connected(server, make_adapter, monkeypatch)
    wall = FakeClock()
    adapter._clock = wall  # 벽시계(백로그·커서·TTL용) — 창 판정에는 쓰이지 않아야 한다
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    wall.now += wall_jump
    clock.now += window_advance
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 2
    if follows:
        assert ok[1]["thread_root_id"] == ids[0]
        assert len(_top_level(ok)) == 1
    else:
        assert len(_top_level(ok)) == 2
        assert adapter._top_posts[CHANNEL_ID] == [(clock.now, ids[1], "media")]  # 기록 시각도 단조 시계


# 13 (#57 b) 창 경계: 정확히 60초는 포함, 넘으면 제외.
@pytest.mark.parametrize("elapsed, follows", [(60.0, True), (60.001, False)])
async def test_window_boundary_inclusive_at_60_seconds(server, make_adapter, monkeypatch, tmp_path,
                                                       elapsed, follows):
    adapter, clock = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    clock.now += elapsed
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 2
    if follows:
        assert ok[1]["thread_root_id"] == ids[0] and len(_top_level(ok)) == 1
    else:
        assert len(_top_level(ok)) == 2


# (#57 c) 교차 실행(첫 조각 post_message 응답 대기 중 첨부)은 가짜 서버에 게시 응답 지연 훅이 없어 쓰지 않았다
# — conftest 필요(REPORT 참고).


# 14 (#57 d) send_document·send_video 대체 글도 본문 스레드에 붙는다(업로드 없음).
@pytest.mark.parametrize("method, name, data", [("send_document", "a.mp3", MP3), ("send_video", "b.png", PNG)])
async def test_document_and_video_fallback_lands_in_text_thread(server, make_adapter, monkeypatch, tmp_path,
                                                                method, name, data):
    from ohmyslack.adapter import ATTACHMENT_FALLBACK
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    res = await getattr(adapter, method)(CHANNEL_ID, _file(tmp_path, name, data))
    assert res.success is True
    assert server.uploads == []
    ok = _posts_ok(server)
    ids = _posted_ids(server)
    assert len(ok) == 2
    assert ok[1]["thread_root_id"] == ids[0]
    assert ok[1]["body"] == ATTACHMENT_FALLBACK and "attachment_ids" not in ok[1]
    assert [e[2] for e in adapter._top_posts[CHANNEL_ID]] == ["text"]  # 스레드 답글이라 기록되지 않는다


# 15 (#57 e) 따라붙은 첨부 글 게시가 실패하면 최상위로 다시 게시하지 않는다(대체 글도 없음).
async def test_followed_attachment_post_failure_is_not_reposted_top_level(server, make_adapter, monkeypatch,
                                                                          tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    assert (await adapter.send(CHANNEL_ID, "아침 브리핑")).success is True
    ids = _posted_ids(server)
    server.post_status = [400]  # 다음 게시(따라붙은 첨부 글)만 실패 — 재시도 대상 아님
    res = await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))
    assert res.success is False
    assert len(server.uploads) == 1
    assert len(server.posts) == 2  # 본문 1 + 실패한 첨부 글 1 — 재게시·대체 글 없음
    failed = server.posts[1]
    assert failed["_status"] == 400 and failed["thread_root_id"] == ids[0] and failed.get("attachment_ids")
    assert len(_top_level(server.posts)) == 1
    assert [e[2] for e in adapter._top_posts[CHANNEL_ID]] == ["text"]


# 16 (#57 f, O-5) 부분 게시(첫 조각만 성공) 뒤 첨부: 첫 조각 기록이 남아 그 스레드에 붙는다(의도, README).
async def test_attachment_after_partial_text_follows_first_chunk_thread(server, make_adapter, monkeypatch,
                                                                        tmp_path):
    adapter, _ = await _connected(server, make_adapter, monkeypatch)
    server.ok_posts_before_429 = 1  # 첫 조각만 게시, 두 번째 조각은 429 소진
    res = await adapter.send(CHANNEL_ID, _long_body())
    server.ok_posts_before_429 = None
    assert res.success is False
    assert res.raw_response["partial_overflow"] is True and res.raw_response["delivered_chunks"] == 1
    ids = _posted_ids(server)
    assert len(ids) == 1
    assert (await adapter.send_voice(CHANNEL_ID, _file(tmp_path, "b.mp3", MP3))).success is True
    ok = _posts_ok(server)
    assert len(ok) == 2
    assert ok[0].get("thread_root_id") is None
    assert ok[1]["thread_root_id"] == ids[0] and ok[1].get("attachment_ids")
    assert len(_top_level(ok)) == 1
