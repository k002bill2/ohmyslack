"""설계 r4 §Q2·§4 단계 5: 파일 읽기 스레드 프로세스 전체 상한(`threading.BoundedSemaphore(4)`, 비차단 acquire).

소유권: 시작 전 = 호출자(시작 실패면 호출자가 반환), `start()` 뒤 = worker(함수 전체 `finally`에서 정확히 한 번 반환).
슬롯 없음 = `read_unavailable`. 정지 읽기는 Event로 멈추고, 테스트 `finally` + 독립 watchdog Timer가 풀어
스위트가 멈추지 않게 한다(끝에 worker `join(timeout)` 후 `is_alive()` 거짓 단언).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path

import pytest

from conftest import DM_ID, TOKEN

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
SLOTS = 4  # 설계 r4 §Q2 READ_SLOTS = ATTACHMENTS_PER_MESSAGE_MAX
WATCHDOG_S = 5.0
JOIN_S = 2.0


def _fresh_slots(monkeypatch) -> threading.BoundedSemaphore:
    """다른 테스트의 남은 스레드와 섞이지 않게 새 세마포어를 주입한다(구현은 호출 시점에 모듈 전역을 읽는다)."""
    import ohmyslack.adapter as adapter_mod
    slots = threading.BoundedSemaphore(SLOTS)
    monkeypatch.setattr(adapter_mod, "_READ_SLOTS", slots, raising=False)
    return slots


def _free(slots: threading.BoundedSemaphore) -> int:
    """지금 비어 있는 슬롯 수(공개 API로만: 비차단 acquire를 셀 때까지 → 모두 되돌림)."""
    taken = 0
    while slots.acquire(blocking=False):
        taken += 1
    for _ in range(taken):
        slots.release()
    return taken


def _thread_errors(monkeypatch) -> list:
    """worker 스레드 안 예외(이중 release의 ValueError 등)는 테스트까지 오지 않으므로 excepthook으로 모은다."""
    errors: list = []
    monkeypatch.setattr(threading, "excepthook", lambda args: errors.append(args.exc_type))
    return errors


class _StuckReads:
    """`read_attachment_file`을 Event로 멈춘다. watchdog Timer가 WATCHDOG_S 뒤 무조건 풀어 준다."""

    def __init__(self, monkeypatch):
        import ohmyslack.adapter as adapter_mod
        self.release = threading.Event()
        self.workers: list[threading.Thread] = []
        self._watchdog = threading.Timer(WATCHDOG_S, self.release.set)
        self._watchdog.daemon = True
        self._watchdog.start()

        def stuck_read(*_args, **_kwargs):
            self.workers.append(threading.current_thread())
            self.release.wait()
            return None, "rejected"
        monkeypatch.setattr(adapter_mod, "read_attachment_file", stuck_read)

    def alive(self) -> list[threading.Thread]:
        return [t for t in self.workers if t.is_alive()]

    def finish(self) -> None:
        self.release.set()
        self._watchdog.cancel()
        for t in self.workers:
            t.join(JOIN_S)


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _cfg(server):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})


async def test_read_slots_cap_across_direct_calls(monkeypatch):
    """`_read_off_loop` 직접 6회: 앞 4회는 대기 timeout으로 호출자가 포기(worker는 정지 중) → 5·6번째 `read_unavailable`."""
    import ohmyslack.adapter as adapter_mod
    slots = _fresh_slots(monkeypatch)
    errors = _thread_errors(monkeypatch)
    stuck = _StuckReads(monkeypatch)
    results: list = []
    try:
        for i in range(6):
            try:
                results.append(await asyncio.wait_for(
                    adapter_mod._read_off_loop(f"p{i}.mp3", adapter_mod.VOICE_TYPES), 0.1))
            except asyncio.TimeoutError:
                results.append("timeout")
        alive = len(stuck.alive())
        free_while_stuck = _free(slots)
    finally:
        stuck.finish()
    assert not stuck.alive(), "stuck read threads must exit after release"
    assert alive <= SLOTS, f"{alive} read threads alive (cap {SLOTS})"
    assert results == ["timeout"] * SLOTS + [(None, "read_unavailable")] * 2
    assert len(stuck.workers) == SLOTS and free_while_stuck == 0
    assert errors == [] and _free(slots) == SLOTS  # 정지가 풀리면 worker가 한 번씩 반환
    assert adapter_mod.READ_SLOTS == SLOTS


@pytest.mark.parametrize("fail_at", ["start", "init"])
async def test_slot_returned_when_start_fails(monkeypatch, tmp_path, fail_at):
    """`Thread(...)` 생성·`start()` 예외 → 호출자가 즉시 반환. 상한보다 많이 실패해도 슬롯 수가 그대로다."""
    import ohmyslack.adapter as adapter_mod
    slots = _fresh_slots(monkeypatch)

    def boom(*_args, **_kwargs):
        raise RuntimeError("can't start new thread")
    results = []
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start" if fail_at == "start" else "__init__", boom)
        for i in range(SLOTS + 1):
            results.append(await adapter_mod._read_off_loop(f"p{i}.mp3", adapter_mod.VOICE_TYPES))
    assert results == [(None, "read_unavailable")] * (SLOTS + 1)
    assert _free(slots) == SLOTS
    loaded, reason = await adapter_mod._read_off_loop(_write(tmp_path, "ok.mp3", MP3), adapter_mod.VOICE_TYPES)
    assert reason == "" and loaded is not None and loaded[2] == "ok.mp3"  # 실패 뒤에도 정상 읽기
    assert _free(slots) == SLOTS


@pytest.mark.parametrize("ending", ["loop_closed", "notify_failure"])
def test_slot_released_once_on_loop_closed_and_notify_failure(monkeypatch, ending):
    """호출자가 포기한 뒤 루프가 닫히거나(조기 반환) 통지가 실패해도(`call_soon_threadsafe` RuntimeError)
    worker가 정확히 한 번 반환한다. 이중 반환은 BoundedSemaphore ValueError → excepthook으로 드러난다."""
    import ohmyslack.adapter as adapter_mod
    slots = _fresh_slots(monkeypatch)
    errors = _thread_errors(monkeypatch)
    stuck = _StuckReads(monkeypatch)
    loop = asyncio.new_event_loop()  # 이 테스트 전용 루프(공용 테스트 루프는 건드리지 않는다)
    try:
        async def give_up() -> None:
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(adapter_mod._read_off_loop("a.mp3", adapter_mod.VOICE_TYPES), 0.1)
        loop.run_until_complete(give_up())
        started = len(stuck.workers)
        free_while_stuck = _free(slots)
        if ending == "notify_failure":
            def refuse(*_args, **_kwargs):
                raise RuntimeError("Event loop is closed")
            loop.call_soon_threadsafe = refuse  # is_closed()는 거짓인데 통지가 실패하는 경쟁 자리
        else:
            loop.close()
    finally:
        stuck.finish()
        if not loop.is_closed():
            loop.close()
    assert not stuck.alive(), "stuck read thread must exit after release"
    assert started == 1
    assert free_while_stuck == SLOTS - 1  # 호출자가 포기해도 worker가 슬롯을 쥔다
    assert errors == []
    assert _free(slots) == SLOTS


async def test_live_attachment_reports_read_unavailable(server, make_adapter, tmp_path, monkeypatch, caplog):
    """라이브 `_send_attachment`: 슬롯이 모두 찬 상태 → 업로드 없이 대체 텍스트, 사유 `read_unavailable`을 버리지 않는다."""
    slots = _fresh_slots(monkeypatch)
    for _ in range(SLOTS):
        assert slots.acquire(blocking=False)  # 멈춘 읽기 4개가 슬롯을 다 쥔 상태
    caplog.set_level(logging.DEBUG)
    adapter = make_adapter()
    assert await adapter.connect()
    path = _write(tmp_path, "briefing.mp3", MP3)
    try:
        res = await adapter.send_voice(DM_ID, path, caption="오늘 브리핑")
    finally:
        for _ in range(SLOTS):
            slots.release()
    assert res.success
    assert server.uploads == []
    posts = [p for p in server.posts if p["_status"] == 200]
    assert len(posts) == 1 and "attachment_ids" not in posts[0] and posts[0]["body"].startswith("오늘 브리핑\n")
    assert "ohmyslack: attachment read_unavailable" in caplog.text
    assert "file read unavailable (reader busy); sending text fallback" in caplog.text
    assert "file rejected" not in caplog.text
    assert "briefing.mp3" not in caplog.text and str(tmp_path) not in caplog.text  # 경로·파일명 로그 금지(B6)


async def test_standalone_full_slots_warn_read_unavailable(server, tmp_path, monkeypatch):
    """standalone: 슬롯 없음 → 파일 경고 enum `read_unavailable`, 텍스트는 보낸다(`media_delivered` 없음)."""
    from ohmyslack.adapter import standalone_send
    slots = _fresh_slots(monkeypatch)
    for _ in range(SLOTS):
        assert slots.acquire(blocking=False)
    path = _write(tmp_path, "briefing.mp3", MP3)
    try:
        out = await standalone_send(_cfg(server), DM_ID, "아침 브리핑", media_files=[(path, True)])
    finally:
        for _ in range(SLOTS):
            slots.release()
    assert out.get("success") is True
    assert out["warnings"] == ["briefing.mp3: read_unavailable"]
    assert "media_delivered" not in out and server.uploads == []
    assert len([p for p in server.posts if p["_status"] == 200]) == 1
