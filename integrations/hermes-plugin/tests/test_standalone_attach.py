"""ADR-002 1a: standalone(게이트웨이 밖 cron) 첨부 — 업로드·결속, 실패는 파일마다 `warnings`(조용한 유실 금지)."""

from __future__ import annotations

import functools
from pathlib import Path

import pytest

from conftest import CHANNEL_ID, DM_ID, TOKEN, FakeClock

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       + b"\x00" * 32)


def _cfg(server):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})


def _ok_posts(server):
    return [p for p in server.posts if p["_status"] == 200]


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


async def _send(server, message, media_files):
    from ohmyslack.adapter import standalone_send
    return await standalone_send(_cfg(server), DM_ID, message, media_files=media_files)


async def test_mp3_is_uploaded_and_bound_to_the_text_message(server, tmp_path):
    path = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, "아침 브리핑", [(path, True)])
    assert out["success"] is True and not out.get("warnings")
    assert out.get("media_delivered") is True  # Hermes generic 경로가 "omitted" 경고를 붙이지 않게
    assert [(u["content_type"], u["conversation_id"], u["size"]) for u in server.uploads] == \
        [("audio/mpeg", DM_ID, len(MP3))]
    posts = _ok_posts(server)
    assert len(posts) == 1
    assert posts[0]["body"] == "아침 브리핑" and "thread_root_id" not in posts[0]
    assert posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]
    assert out["message_id"]


async def test_plain_path_strings_and_images_are_accepted(server, tmp_path):
    png = _write(tmp_path, "chart.png", PNG)
    out = await _send(server, "차트", [png])
    assert out["success"] is True and not out.get("warnings")
    assert [u["content_type"] for u in server.uploads] == ["image/png"]
    assert _ok_posts(server)[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]


async def test_long_text_binds_attachments_to_first_chunk_only(server, tmp_path):
    path = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, "가" * 4500, [(path, True)])
    assert out["success"] is True and not out.get("warnings")
    posts = _ok_posts(server)
    assert len(posts) == 2
    assert posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]
    assert "attachment_ids" not in posts[1]


async def test_unsupported_document_warns_without_upload(server, tmp_path):
    pdf = _write(tmp_path, "report.pdf", b"%PDF-1.4\n" + b"0" * 64)
    out = await _send(server, "보고서", [(pdf, False)])
    assert out["success"] is True
    assert out["warnings"] == ["report.pdf: unsupported_type"]
    assert not out.get("media_delivered")
    assert server.uploads == []
    posts = _ok_posts(server)
    assert len(posts) == 1 and posts[0]["body"] == "보고서" and "attachment_ids" not in posts[0]


@pytest.mark.parametrize("status", [413, 415])
async def test_upload_4xx_warns_and_text_still_sent(server, tmp_path, status):
    path = _write(tmp_path, "briefing.mp3", MP3)
    server.upload_status = [status]
    out = await _send(server, "아침 브리핑", [(path, True)])
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: upload_failed"]
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]


async def test_upload_5xx_after_retries_warns_and_text_still_sent(server, tmp_path, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    from ohmyslack.client import MAX_SEND_ATTEMPTS

    async def no_sleep(_delay):
        return None
    monkeypatch.setattr(adapter_mod, "BotClient", functools.partial(adapter_mod.BotClient, sleep=no_sleep))
    path = _write(tmp_path, "briefing.mp3", MP3)
    server.upload_status = [503] * MAX_SEND_ATTEMPTS
    out = await _send(server, "아침 브리핑", [(path, True)])
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: upload_failed"]
    assert len(server.uploads) == MAX_SEND_ATTEMPTS
    assert len(_ok_posts(server)) == 1


async def test_missing_and_oversize_files_warn_per_file(server, tmp_path):
    missing = str(tmp_path / "gone.mp3")
    big = tmp_path / "huge.mp3"
    with open(big, "wb") as fh:
        fh.truncate(10 * 1024 * 1024 + 1)
    ok = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, "아침 브리핑", [(missing, True), (str(big), True), (ok, True)])
    assert out["success"] is True
    assert out["warnings"] == ["gone.mp3: not_found", "huge.mp3: too_large"]
    assert not out.get("media_delivered")
    assert len(server.uploads) == 1
    assert _ok_posts(server)[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]
    assert all(str(tmp_path) not in w for w in out["warnings"])  # 경로 전체 금지


async def test_more_than_per_message_max_warns_too_many(server, tmp_path):
    paths = [(_write(tmp_path, f"p{i}.png", PNG), False) for i in range(5)]
    out = await _send(server, "차트", paths)
    assert out["success"] is True
    assert out["warnings"] == ["p4.png: too_many"]
    assert len(server.uploads) == 4
    assert len(_ok_posts(server)[0]["attachment_ids"]) == 4


async def test_text_send_failure_is_send_error(server, tmp_path):
    path = _write(tmp_path, "briefing.mp3", MP3)
    server.post_status = [403]
    out = await _send(server, "아침 브리핑", [(path, True)])
    assert "error" in out and "success" not in out
    assert TOKEN not in out["error"]


async def test_non_dm_target_refused_before_upload(server, tmp_path):
    from ohmyslack.adapter import standalone_send
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    path = _write(tmp_path, "briefing.mp3", MP3)
    out = await standalone_send(_cfg(server), CHANNEL_ID, "브리핑", media_files=[(path, True)])
    assert "error" in out
    assert server.uploads == [] and _ok_posts(server) == []


# ---- Codex r1 P1: Hermes 전체 상한(기본 60초) 안에서 텍스트·warnings가 반드시 나가야 한다 ----

async def _send_clocked(server, message, media_files, clock, monkeypatch, **kwargs):
    import ohmyslack.adapter as adapter_mod
    monkeypatch.setattr(adapter_mod, "BotClient", functools.partial(adapter_mod.BotClient, sleep=clock.sleep))
    return await adapter_mod.standalone_send(_cfg(server), DM_ID, message, media_files=media_files,
                                             clock=clock, **kwargs)


async def test_upload_429_with_retry_after_beyond_budget_gives_up_at_once(server, tmp_path, monkeypatch):
    from ohmyslack.adapter import STANDALONE_UPLOAD_BUDGET_S
    clock = FakeClock()
    start = clock.now
    path = _write(tmp_path, "briefing.mp3", MP3)
    server.upload_status = [429]
    server.upload_retry_after = "60"
    out = await _send_clocked(server, "아침 브리핑", [(path, True)], clock, monkeypatch)
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: upload_failed"]
    assert len(server.uploads) == 1 and clock.sleeps == []  # 남은 예산보다 긴 Retry-After는 기다리지 않는다
    assert clock.now - start <= STANDALONE_UPLOAD_BUDGET_S
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]


async def test_slow_upload_exhausting_budget_skips_rest_as_budget_exceeded(server, tmp_path, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    clock = FakeClock()
    real_upload = adapter_mod.BotClient.upload_attachment
    calls: list[str] = []

    async def slow_upload(self, *args, **kwargs):
        calls.append("upload")
        res = await real_upload(self, *args, **kwargs)
        clock.now += adapter_mod.STANDALONE_UPLOAD_BUDGET_S + 1  # 첫 업로드가 예산을 다 쓴다
        return res
    monkeypatch.setattr(adapter_mod.BotClient, "upload_attachment", slow_upload)
    real_read = adapter_mod.read_attachment_file
    reads: list[str] = []

    def counting_read(path, *args):
        reads.append(Path(path).name)
        return real_read(path, *args)
    monkeypatch.setattr(adapter_mod, "read_attachment_file", counting_read)
    paths = [(_write(tmp_path, f"p{i}.png", PNG), False) for i in range(3)]
    out = await _send_clocked(server, "차트", paths, clock, monkeypatch)
    assert out["success"] is True
    assert out["warnings"] == ["p1.png: budget_exceeded", "p2.png: budget_exceeded"]
    assert len(server.uploads) == 1 and calls == ["upload"]  # 예산 소진 뒤에는 업로드를 시작하지도 않는다
    assert reads == ["p0.png"]  # 파일도 읽지 않는다
    posts = _ok_posts(server)
    assert len(posts) == 1 and posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]


async def test_hanging_upload_is_cut_at_budget_and_text_still_sent(server, tmp_path):
    from ohmyslack.adapter import standalone_send
    path = _write(tmp_path, "briefing.mp3", MP3)
    other = _write(tmp_path, "chart.png", PNG)
    server.upload_delay = 0.3  # 예산(0.05초)보다 충분히 길게, teardown 대기는 짧게
    out = await standalone_send(_cfg(server), DM_ID, "아침 브리핑", media_files=[(path, True), other],
                                upload_budget=0.05)
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: budget_exceeded", "chart.png: budget_exceeded"]
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]


async def test_upload_attempts_capped_at_per_message_max_regardless_of_success(server, tmp_path, monkeypatch):
    clock = FakeClock()
    paths = [(_write(tmp_path, f"p{i}.png", PNG), False) for i in range(6)]
    server.upload_status = [413] * 5
    out = await _send_clocked(server, "차트", paths, clock, monkeypatch)
    assert out["success"] is True
    assert len(server.uploads) <= 4
    assert out["warnings"] == [f"p{i}.png: upload_failed" for i in range(4)] + ["p4.png: too_many",
                                                                                 "p5.png: too_many"]
    assert "attachment_ids" not in _ok_posts(server)[0]


# ---- Codex r2 P1: 전송 전체(`/me`·읽기·업로드·텍스트 게시)를 시작 시각 기준 deadline 안에 끝낸다 ----

def _slow_me(monkeypatch, clock, seconds):
    import ohmyslack.adapter as adapter_mod
    real_get_me = adapter_mod.BotClient.get_me

    async def slow_get_me(self):
        res = await real_get_me(self)
        clock.now += seconds  # /me가 seconds초 걸린 상황
        return res
    monkeypatch.setattr(adapter_mod.BotClient, "get_me", slow_get_me)


async def test_slow_me_shrinks_upload_budget_so_text_lands_before_deadline(server, tmp_path, monkeypatch):
    from ohmyslack.adapter import STANDALONE_TOTAL_DEADLINE_S
    clock = FakeClock()
    start = clock.now
    _slow_me(monkeypatch, clock, 12.0)
    path = _write(tmp_path, "briefing.mp3", MP3)
    server.upload_status = [429]
    server.upload_retry_after = "10"  # 업로드 예산(15초)보다 짧지만 deadline 남은 몫(25−12−8=5초)보다 길다
    out = await _send_clocked(server, "아침 브리핑", [(path, True)], clock, monkeypatch)
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: upload_failed"]
    assert clock.sleeps == [] and len(server.uploads) == 1
    posts = _ok_posts(server)
    assert len(posts) == 1 and posts[0]["body"] == "아침 브리핑"
    assert clock.now - start <= STANDALONE_TOTAL_DEADLINE_S


async def test_text_post_429_beyond_deadline_fails_fast_with_send_error(server, tmp_path, monkeypatch):
    from ohmyslack.adapter import STANDALONE_TOTAL_DEADLINE_S
    clock = FakeClock()
    start = clock.now
    server.post_status = [429]
    server.post_retry_after = "60"
    out = await _send_clocked(server, "아침 브리핑", None, clock, monkeypatch)
    assert "error" in out and "success" not in out
    assert "HTTP 429" in out["error"]
    assert clock.sleeps == [] and _ok_posts(server) == []  # 남은 시간보다 긴 Retry-After는 기다리지 않는다
    assert clock.now - start <= STANDALONE_TOTAL_DEADLINE_S


async def test_slow_file_read_is_cut_at_budget_and_text_still_sent(server, tmp_path, monkeypatch):
    import threading
    import time

    import ohmyslack.adapter as adapter_mod
    release = threading.Event()

    def stuck_read(path, *args):
        release.wait(2.0)  # 파일 시스템이 멈춘 상황(테스트 끝에 풀어 스레드를 정리)
        return None, "rejected"
    monkeypatch.setattr(adapter_mod, "read_attachment_file", stuck_read)
    path = _write(tmp_path, "briefing.mp3", MP3)
    began = time.monotonic()
    try:
        out = await adapter_mod.standalone_send(_cfg(server), DM_ID, "아침 브리핑", media_files=[(path, True)],
                                                upload_budget=0.05)
        elapsed = time.monotonic() - began
    finally:
        release.set()
    assert elapsed < 1.0  # 읽기를 끝까지 기다리지 않는다
    assert out["success"] is True
    assert out["warnings"] == ["briefing.mp3: budget_exceeded"]
    posts = _ok_posts(server)
    assert len(posts) == 1 and "attachment_ids" not in posts[0]


async def test_me_exhausting_deadline_skips_upload_and_post(server, tmp_path, monkeypatch):
    from ohmyslack.adapter import STANDALONE_TOTAL_DEADLINE_S
    clock = FakeClock()
    _slow_me(monkeypatch, clock, STANDALONE_TOTAL_DEADLINE_S)
    path = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send_clocked(server, "아침 브리핑", [(path, True)], clock, monkeypatch)
    assert "error" in out and "success" not in out
    assert "deadline_exceeded" in out["error"]
    assert "briefing.mp3: budget_exceeded" in out["error"]  # 실패 로그에 첨부 사유도 남는다
    assert server.uploads == [] and server.posts == []
