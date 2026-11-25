"""oms-doc-inbound: 사람이 올린 문서·텍스트 첨부를 Hermes 문서 캐시에 두고 MessageEvent에 싣는다.

대상 MIME = shared/attachments.ts ATTACHMENT_FILE_MIMES, 파일당 상한 = ATTACHMENT_DOC_MAX_BYTES(25 MiB).
가짜 서버(conftest)의 `blobs[aid] = (mime, bytes)`로 문서를 내준다 — conftest는 수정하지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path

import pytest

from conftest import make_message, wait_for

PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
PDF_MIME = "application/pdf"
PPTX = b"PK\x03\x04" + b"\x00" * 60 + b"ppt/presentation.xml"
PDF = b"%PDF-1.7\n" + b"0" * 64
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       + b"\x00" * 32)
IMAGE_MAX = 10 * 1024 * 1024
DOC_MAX = 25 * 1024 * 1024


def _att(server, mime: str, data: bytes | None, filename: str | None = None) -> dict:
    aid = str(uuid.uuid4())
    if data is not None:
        server.blobs[aid] = (mime, data)
    att = {"id": aid, "mime": mime, "byte_size": len(data or b""), "expires_at": "2099-01-01T00:00:00Z",
           "expired": False}
    if filename is not None:
        att["filename"] = filename
    return att


def _message(*atts: dict, body: str = "이 문서 봐줘") -> dict:
    m = make_message(body=body)
    m["attachments"] = list(atts)
    return m


async def _connected(make_adapter, server):
    adapter = make_adapter()
    assert await adapter.connect()
    await wait_for(lambda: server.sockets)
    return adapter


async def test_inbound_pptx_document_is_cached_with_filename(server, make_adapter, tmp_path):
    from gateway.platforms.event import MessageType
    adapter = await _connected(make_adapter, server)
    att = _att(server, PPTX_MIME, PPTX, filename="분기 보고서.pptx")
    await server.push_live(_message(att))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [att["id"]]
    assert event.message_type == MessageType.DOCUMENT
    assert event.media_types == [PPTX_MIME]
    assert len(event.media_urls) == 1
    path = Path(event.media_urls[0])
    assert path.is_absolute() and str(path).startswith(str(tmp_path))
    assert "분기 보고서.pptx" in path.name
    assert path.read_bytes() == PPTX
    assert event.text == "이 문서 봐줘"


async def test_inbound_image_and_document_mixed_keep_order(server, make_adapter):
    from gateway.platforms.event import MessageType
    adapter = await _connected(make_adapter, server)
    img = _att(server, "image/png", PNG)
    doc = _att(server, PDF_MIME, PDF, filename="contract.pdf")
    await server.push_live(_message(img, doc))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [img["id"], doc["id"]]
    assert event.message_type == MessageType.DOCUMENT
    assert event.media_types[0].startswith("image/") and event.media_types[0] == "image/png"
    assert event.media_types[1] == PDF_MIME
    assert Path(event.media_urls[0]).read_bytes() == PNG
    assert Path(event.media_urls[1]).read_bytes() == PDF
    assert "contract.pdf" in Path(event.media_urls[1]).name


async def test_inbound_text_document_without_filename_gets_default_name(server, make_adapter):
    from gateway.platforms.event import MessageType
    adapter = await _connected(make_adapter, server)
    att = _att(server, "text/markdown", b"# memo\n- a\n")
    await server.push_live(_message(att, body="[문서]"))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [att["id"]]
    assert event.message_type == MessageType.DOCUMENT
    assert len(event.media_urls) == 1
    assert Path(event.media_urls[0]).name.endswith("document.md")
    assert event.media_types == ["text/markdown"]
    assert event.text == "[문서]"  # 자리표시 본문은 가공하지 않는다


async def test_inbound_document_path_components_are_stripped(server, make_adapter, tmp_path):
    adapter = await _connected(make_adapter, server)
    att = _att(server, PDF_MIME, PDF, filename="../../etc/evil.pdf")
    await server.push_live(_message(att))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert len(event.media_urls) == 1
    path = Path(event.media_urls[0])
    assert path.name.endswith("evil.pdf") and ".." not in path.name
    assert str(path.resolve()).startswith(str(tmp_path.resolve()))


async def test_inbound_document_over_25mib_is_skipped_without_filename_in_logs(server, make_adapter, caplog):
    from gateway.platforms.event import MessageType
    caplog.set_level(logging.DEBUG)
    adapter = await _connected(make_adapter, server)
    secret_name = "secret-plan-xyz.pdf"
    att = _att(server, PDF_MIME, b"%PDF-" + b"\x00" * (DOC_MAX + 1 - 5), filename=secret_name)
    await server.push_live(_message(att))
    await wait_for(lambda: len(adapter.events) == 1, timeout=10.0)
    event = adapter.events[0]
    assert server.downloads == [att["id"]]
    assert event.media_urls == [] and event.media_types == []
    assert event.message_type == MessageType.TEXT
    assert event.text == "이 문서 봐줘"
    assert att["id"] in caplog.text
    assert "secret-plan-xyz" not in caplog.text


async def test_inbound_document_between_10_and_25_mib_is_accepted(server, make_adapter):
    adapter = await _connected(make_adapter, server)
    data = b"%PDF-" + b"\x00" * (IMAGE_MAX + 1 - 5)
    att = _att(server, PDF_MIME, data, filename="big.pdf")
    await server.push_live(_message(att))
    await wait_for(lambda: len(adapter.events) == 1, timeout=10.0)
    event = adapter.events[0]
    assert len(event.media_urls) == 1
    assert os.path.getsize(event.media_urls[0]) == len(data)


async def test_inbound_unsupported_media_are_not_downloaded(server, make_adapter):
    from gateway.platforms.event import MessageType
    adapter = await _connected(make_adapter, server)
    expired_doc = _att(server, PDF_MIME, PDF, filename="old.pdf")
    expired_doc["expired"] = True
    messages = [
        _message(_att(server, "audio/mpeg", b"ID3" + b"\x00" * 32)),
        _message(_att(server, "video/mp4", b"\x00" * 32, filename="clip.mp4")),
        _message(_att(server, "application/zip", b"PK\x03\x04", filename="a.zip")),
        _message(_att(server, "image/svg+xml", b"<svg/>", filename="a.svg")),
        _message(expired_doc),
    ]
    for m in messages:
        await server.push_live(m)
    await wait_for(lambda: len(adapter.events) == len(messages))
    assert server.downloads == []
    assert all(e.media_urls == [] and e.message_type == MessageType.TEXT for e in adapter.events)


async def test_inbound_attachment_count_cap_is_kept(server, make_adapter):
    from ohmyslack.adapter import ATTACHMENTS_PER_MESSAGE_MAX
    adapter = await _connected(make_adapter, server)
    atts = [_att(server, "text/plain", f"note {i}\n".encode(), filename=f"n{i}.txt")
            for i in range(ATTACHMENTS_PER_MESSAGE_MAX + 1)]
    await server.push_live(_message(*atts))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [a["id"] for a in atts[:ATTACHMENTS_PER_MESSAGE_MAX]]
    assert len(event.media_urls) == ATTACHMENTS_PER_MESSAGE_MAX


async def test_inbound_document_cache_none_is_skipped(server, make_adapter, monkeypatch):
    from gateway.platforms import base
    from gateway.platforms.event import MessageType

    async def _none(*_args, **_kwargs):
        return None

    monkeypatch.setattr(base, "cache_media_bytes_async", _none, raising=False)
    adapter = await _connected(make_adapter, server)
    att = _att(server, PDF_MIME, PDF, filename="x.pdf")
    await server.push_live(_message(att))
    await wait_for(lambda: len(adapter.events) == 1)
    event = adapter.events[0]
    assert server.downloads == [att["id"]]
    assert event.media_urls == [] and event.message_type == MessageType.TEXT


async def test_inbound_document_cancel_propagates(server, make_adapter, monkeypatch):
    adapter = await _connected(make_adapter, server)
    calls: list[tuple[str, dict]] = []

    async def _cancelled(aid, **kwargs):
        calls.append((aid, kwargs))
        raise asyncio.CancelledError

    monkeypatch.setattr(adapter._client, "download_attachment", _cancelled)
    att = _att(server, PDF_MIME, PDF, filename="x.pdf")
    with pytest.raises(asyncio.CancelledError):
        await adapter._cache_inbound_media(_message(att))
    assert calls == [(att["id"], {"max_bytes": DOC_MAX})]
