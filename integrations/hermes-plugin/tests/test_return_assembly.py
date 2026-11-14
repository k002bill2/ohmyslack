"""설계 r4 §Q3·§4 단계 4: standalone 반환 조립 — 파일 경고·텍스트 경고 분리, `media_delivered` 조건(M1).

`media_delivered = 첨부 ID 있음 ∧ 파일 경고 0 ∧ 청크 0 confirmed`. 텍스트 경고(`partial_delivery` 등)와는 독립이다.
"""

from __future__ import annotations

import functools
from pathlib import Path

from conftest import DM_ID, TOKEN

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
LONG_TEXT = "가" * 9000  # 어댑터 내부 청크 3개


def _cfg(server):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})


def _stored(server) -> list[dict]:
    return [p for p in server.posts if p["_status"] == 200]


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _no_sleep(monkeypatch) -> None:
    import ohmyslack.adapter as adapter_mod

    async def sleep(_delay: float) -> None:
        return None
    monkeypatch.setattr(adapter_mod, "BotClient", functools.partial(adapter_mod.BotClient, sleep=sleep))


async def _send(server, message, media_files=None):
    from ohmyslack.adapter import standalone_send
    return await standalone_send(_cfg(server), DM_ID, message, media_files=media_files)


async def test_media_not_delivered_when_any_file_warning(server, tmp_path, monkeypatch):
    """파일 일부 실패 + 청크 0 확인(+ 뒤 청크 실패) → 파일 경고·텍스트 경고 순서대로, `media_delivered` 없음."""
    _no_sleep(monkeypatch)
    server.ok_posts_before_429 = 1
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, LONG_TEXT, [(mp3, True), (str(tmp_path / "gone.mp3"), True)])
    assert out.get("success") is True
    assert out["warnings"] == ["gone.mp3: not_found", "text: partial_delivery 1/3"]
    assert "media_delivered" not in out
    posts = _stored(server)
    assert len(posts) == 1 and posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]


async def test_media_not_delivered_when_chunk0_unknown(server, tmp_path, monkeypatch):
    """첨부 업로드 성공 + 청크 0 불명(커밋 후 끊김 반복 + 확인 GET 실패) → send_error, `media_delivered` 없음."""
    _no_sleep(monkeypatch)
    server.post_disconnect_after_commit = 4
    server.history_disconnect = 2  # aiohttp가 끊긴 GET을 1회 자동 재전송하므로 두 번 끊는다
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, "아침 브리핑", [(mp3, True)])
    assert "success" not in out and "delivery_unknown chunk 1/1" in out["error"]
    assert "media_delivered" not in out
    assert len(server.uploads) == 1


async def test_text_only_success_has_no_media_delivered(server):
    out = await _send(server, "아침 브리핑")
    assert out.get("success") is True and "media_delivered" not in out and not out.get("warnings")


async def test_empty_input_returns_error(server):
    out = await _send(server, "")
    assert "success" not in out and out.get("error")
    assert _stored(server) == [] and server.uploads == []
    assert "media_delivered" not in out


async def test_all_files_failed_no_body_returns_error_with_warnings(server, tmp_path):
    pdf = _write(tmp_path, "report.pdf", b"%PDF-1.4\n" + b"0" * 64)
    out = await _send(server, "", [(str(tmp_path / "gone.mp3"), True), (pdf, False)])
    assert "success" not in out
    assert "gone.mp3: not_found" in out["error"] and "report.pdf: unsupported_type" in out["error"]
    assert _stored(server) == [] and server.uploads == []
    assert "media_delivered" not in out
