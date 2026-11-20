"""W-20 H2 첨부 송수신(ADR-001 §3-g): send_voice(mp3)·send_image_file(png/jpeg/webp) 업로드 + 이미지 수신 캐시."""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

import pytest

from conftest import DM_ID, TOKEN, make_message, wait_for

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       + b"\x00" * 32)
MAX = 10 * 1024 * 1024


def _ok_posts(server):
    return [p for p in server.posts if p["_status"] == 200]


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


async def _connected(make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    return adapter


# ---------- 송신 ----------
async def test_send_voice_mp3_uploads_then_posts_with_caption(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    path = _write(tmp_path, "briefing.mp3", MP3)
    res = await adapter.send_voice(DM_ID, path, caption="오늘 브리핑")
    assert res.success
    assert [(u["content_type"], u["conversation_id"], u["size"]) for u in server.uploads] == \
        [("audio/mpeg", DM_ID, len(MP3))]
    posts = _ok_posts(server)
    assert len(posts) == 1
    assert posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]
    assert posts[0]["body"] == "오늘 브리핑"


async def test_send_image_png_without_caption_uses_file_name_and_thread(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    root = str(uuid.uuid4())
    path = _write(tmp_path, "chart.png", PNG)
    server.add(make_message(mid=root))  # 봇에게 보이는 루트(P2-3)
    res = await adapter.send_image_file(DM_ID, path, metadata={"thread_id": root})
    assert res.success
    assert [u["content_type"] for u in server.uploads] == ["image/png"]
    post = _ok_posts(server)[0]
    assert post["body"] == "chart.png"
    assert post["thread_root_id"] == root
    assert post["attachment_ids"] == [server.uploads[0]["attachment_id"]]


@pytest.mark.parametrize("name", ["voice.ogg", "voice.wav", "doc.pdf", "pic.svg", "noext"])
async def test_disallowed_type_falls_back_to_text_without_upload(server, make_adapter, tmp_path, name):
    adapter = await _connected(make_adapter)
    path = _write(tmp_path, name, MP3)
    sender = adapter.send_voice if name.startswith("voice") else adapter.send_image_file
    res = await sender(DM_ID, path, caption="cap")
    assert res.success
    assert server.uploads == []
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]
    assert posts[0]["body"].startswith("cap\n")


async def test_declared_mime_mismatch_falls_back(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    path = _write(tmp_path, "a.mp3", MP3)
    await adapter.send_voice(DM_ID, path, mime_type="audio/ogg")
    assert server.uploads == []


async def test_oversize_missing_symlink_and_directory_fall_back(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    big = tmp_path / "big.mp3"
    with open(big, "wb") as fh:
        fh.truncate(MAX + 1)  # sparse — 디스크 사용 없음
    real = Path(_write(tmp_path, "real.png", PNG))
    link = tmp_path / "link.png"
    os.symlink(real, link)
    folder = tmp_path / "dir.png"
    folder.mkdir()
    await adapter.send_voice(DM_ID, str(big))
    await adapter.send_voice(DM_ID, str(tmp_path / "missing.mp3"))
    await adapter.send_image_file(DM_ID, str(link))
    await adapter.send_image_file(DM_ID, str(folder))
    assert server.uploads == []
    assert len(_ok_posts(server)) == 4
    assert all("attachment_ids" not in p for p in _ok_posts(server))


async def test_exactly_max_size_is_uploaded(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    path = tmp_path / "edge.mp3"
    with open(path, "wb") as fh:
        fh.write(MP3)
        fh.truncate(MAX)
    res = await adapter.send_voice(DM_ID, str(path))
    assert res.success
    assert [u["size"] for u in server.uploads] == [MAX]


async def test_upload_429_retries_after_retry_after(server, make_adapter, fake_sleep, tmp_path):
    adapter = await _connected(make_adapter)
    server.upload_status = [429]
    res = await adapter.send_voice(DM_ID, _write(tmp_path, "a.mp3", MP3))
    assert res.success
    assert [u["_status"] for u in server.uploads] == [429, 201]
    assert 1.0 in fake_sleep.calls
    assert _ok_posts(server)[0]["attachment_ids"] == [server.uploads[1]["attachment_id"]]


@pytest.mark.parametrize("status", [400, 413])
async def test_upload_4xx_falls_back_without_retry(server, make_adapter, tmp_path, status):
    adapter = await _connected(make_adapter)
    server.upload_status = [status]
    res = await adapter.send_image_file(DM_ID, _write(tmp_path, "a.png", PNG), caption="cap")
    assert res.success
    assert [u["_status"] for u in server.uploads] == [status]
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]


async def test_message_failure_after_upload_does_not_post_fallback(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    server.post_status = [400]
    res = await adapter.send_voice(DM_ID, _write(tmp_path, "a.mp3", MP3), caption="cap")
    assert not res.success
    assert len(server.uploads) == 1
    assert _ok_posts(server) == []  # 미결속 첨부는 서버 1시간 정리에 맡긴다


async def test_long_caption_attaches_to_first_chunk_only(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    res = await adapter.send_voice(DM_ID, _write(tmp_path, "a.mp3", MP3), caption="x" * 4500)
    assert res.success
    posts = _ok_posts(server)
    assert len(posts) == 2
    assert posts[0]["attachment_ids"] and "attachment_ids" not in posts[1]
    assert res.message_id == str(uuid.UUID(res.message_id))


async def test_document_and_video_still_text_fallback(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter)
    await adapter.send_document(DM_ID, _write(tmp_path, "a.mp3", MP3))
    await adapter.send_video(DM_ID, _write(tmp_path, "b.png", PNG))
    assert server.uploads == []


# ---------- 수신 ----------
def _with_attachment(server, mime: str, data: bytes | None) -> dict:
    aid = str(uuid.uuid4())
    if data is not None:
        server.blobs[aid] = (mime, data)
    m = make_message(body="이거 봐줘")
    m["attachments"] = [{"id": aid, "mime": mime, "byte_size": len(data or b""), "expires_at": "2099-01-01T00:00:00Z",
                         "expired": False}]
    return m


async def test_inbound_image_is_downloaded_once_and_cached(server, make_adapter, tmp_path):
    from gateway.platforms.event import MessageType
    adapter = await _connected(make_adapter)
    await wait_for(lambda: server.sockets)
    m = _with_attachment(server, "image/png", PNG)
    await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [m["attachments"][0]["id"]]
    assert event.message_type == MessageType.PHOTO
    assert event.media_types == ["image/png"]
    assert len(event.media_urls) == 1 and event.media_urls[0].startswith(str(tmp_path))
    assert Path(event.media_urls[0]).read_bytes() == PNG
    assert event.text == "이거 봐줘"
    auth = [h for meth, path, h in server.requests if path.startswith("/api/bot/v1/attachments/")]
    assert auth and auth[0]["Authorization"] == f"Bearer {TOKEN}"


async def test_inbound_download_404_delivers_text_only(server, make_adapter, caplog):
    from gateway.platforms.event import MessageType
    caplog.set_level(logging.DEBUG)
    adapter = await _connected(make_adapter)
    await wait_for(lambda: server.sockets)
    m = _with_attachment(server, "image/jpeg", None)
    await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert len(server.downloads) == 1
    assert event.media_urls == [] and event.message_type == MessageType.TEXT
    assert event.text == "이거 봐줘"
    assert m["attachments"][0]["id"] in caplog.text


async def test_inbound_audio_and_expired_are_not_downloaded(server, make_adapter):
    adapter = await _connected(make_adapter)
    await wait_for(lambda: server.sockets)
    audio = _with_attachment(server, "audio/mpeg", MP3)
    expired = _with_attachment(server, "image/png", PNG)
    expired["attachments"][0]["expired"] = True
    await server.push_live(audio)
    await server.push_live(expired)
    await wait_for(lambda: len(adapter.events) == 2)
    assert server.downloads == []


# ---------- 로그 누출 ----------
async def test_attachment_logs_and_errors_have_no_token_path_or_caption(server, make_adapter, tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    adapter = await _connected(make_adapter)
    secret_dir = tmp_path / "secret-dir-xyz"
    secret_dir.mkdir()
    caption = "캡션-누출-카나리아"
    results = [await adapter.send_voice(DM_ID, str(secret_dir / "x.ogg"), caption=caption)]
    server.upload_status = [413]
    results.append(await adapter.send_voice(DM_ID, _write(secret_dir, "y.mp3", MP3), caption=caption))
    server.post_status = [500, 500, 500, 500]
    results.append(await adapter.send_image_file(DM_ID, _write(secret_dir, "z.png", PNG), caption=caption))
    text = caplog.text + " ".join(str(r.error) for r in results)
    for needle in (TOKEN, "secret-dir-xyz", caption):
        assert needle not in text
