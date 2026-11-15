"""단계 6 Q4: standalone 절대 deadline·바깥 상한·명시적 세션 정리(DESIGN p2s1-1a-design-r4 §Q4·단계 6).

시간 상한 테스트는 `standalone_send`를 별도 daemon 스레드의 `asyncio.run`에서 돌리고 테스트 스레드가
`join(TOTAL + 여유)` 뒤 `is_alive()`를 단언한다 — 같은 루프의 `wait_for`에 기대지 않아 뮤테이션이 스위트를 멈추지 않고 FAIL.
정지는 모두 협조적(`asyncio.Event().wait()`)이며, finally에서 대상 루프에 set을 넘겨 스레드를 풀고 다시 join한다.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from conftest import DM_ID, TOKEN

TOTAL = 0.5
WATCHDOG_SLACK = 2.0  # 스레드 join 여유(상한 단언과 별개 — 단언은 아래 BOUND_SLACK)
BOUND_SLACK = 0.5  # DESIGN §5-1 #8: 반환 ≤ TOTAL + 0.5초


def _cfg(base: str):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": base})


class _Hang:
    """대상 루프 안의 협조적 무기한 대기. `release()`는 다른 스레드에서 불러도 안전(루프에 set을 넘김)."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self._loop = None
        self._event = None

    async def wait(self) -> None:
        self._loop, self._event = asyncio.get_running_loop(), asyncio.Event()
        self.entered.set()
        await self._event.wait()

    def release(self) -> None:
        if self._loop is not None and not self._loop.is_closed():
            try:
                self._loop.call_soon_threadsafe(self._event.set)
            except RuntimeError:
                pass


def _run_bounded(coro_fn, hang: _Hang, limit: float):
    """daemon 스레드 asyncio.run → (alive_after_limit, box). box: out | exc, elapsed(코루틴 안 측정)."""
    box: dict = {}

    def target() -> None:
        async def main():
            began = time.monotonic()
            try:
                box["out"] = await coro_fn()
            finally:
                box["elapsed"] = time.monotonic() - began
        try:
            asyncio.run(main())
        except BaseException as exc:  # noqa: BLE001 — 스레드 밖으로 결과를 옮긴다
            box["exc"] = exc
    runner = threading.Thread(target=target, name="standalone-deadline", daemon=True)
    runner.start()
    try:
        runner.join(limit)
        alive = runner.is_alive()
    finally:
        hang.release()
        runner.join(5.0)
    assert not runner.is_alive(), "watchdog release did not end the runner thread"
    return alive, box


@pytest.fixture
def total(monkeypatch):
    import ohmyslack.adapter as adapter_mod
    monkeypatch.setattr(adapter_mod, "STANDALONE_TOTAL_DEADLINE_S", TOTAL)
    return TOTAL


class _Session:
    """aiohttp 세션 위임 + close 동작 교체(`hang` 또는 `error`)."""

    def __init__(self, inner, *, hang: _Hang | None = None, error: Exception | None = None) -> None:
        self._inner, self._hang, self._error = inner, hang, error
        self.close_calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def close(self) -> None:
        self.close_calls += 1
        try:
            if self._hang is not None:
                await self._hang.wait()
            if self._error is not None:
                raise self._error
        finally:
            await self._inner.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()


def _factory(sessions: list, **kw):
    from ohmyslack.client import new_session

    def make():
        s = _Session(new_session(), **kw)
        sessions.append(s)
        return s
    return make


def _ok_posts(server):
    return [p for p in server.posts if p["_status"] == 200]


def test_close_hang_returns_within_total(thread_server, total):
    from ohmyslack.adapter import standalone_send
    hang, sessions = _Hang(), []
    alive, box = _run_bounded(lambda: standalone_send(_cfg(thread_server.base), DM_ID, "아침 브리핑",
                                                      session_factory=_factory(sessions, hang=hang)),
                              hang, total + WATCHDOG_SLACK)
    assert not alive, "standalone_send did not return while session.close() hung"
    assert hang.entered.is_set() and len(sessions) == 1 and sessions[0].close_calls == 1
    assert box["elapsed"] <= total + BOUND_SLACK
    assert box["out"].get("success") is True and len(_ok_posts(thread_server)) == 1


def test_me_hang_cut_at_me_share_without_posts(thread_server, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    total = 2.0  # me 몫 0.24초 vs prep 몫 1.2초 — 둘이 BOUND_SLACK보다 멀어 /me를 prep으로만 묶는 회귀를 가른다
    monkeypatch.setattr(adapter_mod, "STANDALONE_TOTAL_DEADLINE_S", total)
    hang = _Hang()

    async def stuck_get_me(self):
        await hang.wait()
    monkeypatch.setattr(adapter_mod.BotClient, "get_me", stuck_get_me)
    alive, box = _run_bounded(lambda: adapter_mod.standalone_send(_cfg(thread_server.base), DM_ID, "브리핑"),
                              hang, total + WATCHDOG_SLACK)
    assert not alive and hang.entered.is_set()
    me_share = adapter_mod._BUDGET_SPLIT["me"] * total
    assert box["elapsed"] <= me_share + BOUND_SLACK
    assert "error" in box["out"] and "deadline_exceeded" in box["out"]["error"]
    assert thread_server.posts == [] and thread_server.uploads == []


def test_post_hang_after_entry_records_attempted_and_confirms_once(thread_server, total, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    hang = _Hang()

    async def stuck_post(self, *args, **kwargs):
        await hang.wait()  # 진입 표지 set 뒤 정지(요청이 서버에 닿았는지 모름)
    monkeypatch.setattr(adapter_mod.BotClient, "post_message", stuck_post)
    alive, box = _run_bounded(lambda: adapter_mod.standalone_send(_cfg(thread_server.base), DM_ID, "브리핑"),
                              hang, total + WATCHDOG_SLACK)
    assert not alive and hang.entered.is_set()
    assert box["elapsed"] <= total + BOUND_SLACK
    assert "delivery_unknown chunk 1/1" in box["out"]["error"]
    assert thread_server.history_calls == 1  # post 몫이 끝난 뒤에도 confirm 몫으로 확인 GET 1회


def test_commit_then_post_hang_is_confirmed_by_confirm_share(thread_server, total, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    hang = _Hang()
    real_post = adapter_mod.BotClient.post_message

    async def commit_then_hang(self, *args, **kwargs):
        await real_post(self, *args, **kwargs)  # 서버 커밋 완료
        await hang.wait()  # 응답 유실처럼 post 몫을 넘긴다
    monkeypatch.setattr(adapter_mod.BotClient, "post_message", commit_then_hang)
    alive, box = _run_bounded(lambda: adapter_mod.standalone_send(_cfg(thread_server.base), DM_ID, "브리핑"),
                              hang, total + WATCHDOG_SLACK)
    assert not alive and hang.entered.is_set()
    assert box["out"].get("success") is True and box["out"].get("message_id")
    assert len(_ok_posts(thread_server)) == 1 and thread_server.history_calls == 1


def test_cleanup_exception_preserves_confirmed(thread_server, total):
    from ohmyslack.adapter import standalone_send
    hang, sessions = _Hang(), []
    alive, box = _run_bounded(lambda: standalone_send(_cfg(thread_server.base), DM_ID, "브리핑",
                                                      session_factory=_factory(sessions, error=OSError("boom"))),
                              hang, total + WATCHDOG_SLACK)
    assert not alive and "exc" not in box, box.get("exc")
    assert box["out"].get("success") is True and len(_ok_posts(thread_server)) == 1
    assert sessions[0].close_calls == 1


def test_external_cancel_propagates(thread_server, total, monkeypatch):
    """가드: 우리 timeout이 아닌 취소(Hermes wait_for 등)는 삼키지 않는다. 정리는 그래도 1회."""
    import ohmyslack.adapter as adapter_mod
    hang, sessions = _Hang(), []

    async def stuck_get_me(self):
        await hang.wait()
    monkeypatch.setattr(adapter_mod.BotClient, "get_me", stuck_get_me)

    async def cancel_from_outside():
        task = asyncio.ensure_future(adapter_mod.standalone_send(
            _cfg(thread_server.base), DM_ID, "브리핑", session_factory=_factory(sessions)))
        while not hang.entered.is_set():
            await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return "cancelled"
        return "swallowed"
    alive, box = _run_bounded(cancel_from_outside, hang, total + WATCHDOG_SLACK)
    assert not alive and box.get("out") == "cancelled"
    assert sessions[0].close_calls == 1


def test_budget_split_scales_with_total_only():
    import ohmyslack.adapter as adapter_mod
    split = adapter_mod._BUDGET_SPLIT
    assert split == {"me": 0.12, "prep": 0.60, "post": 0.80, "confirm": 0.92, "cleanup": 1.0}
    d = adapter_mod._standalone_deadlines(100.0, 0.5)
    assert (d.me, d.prep, d.post, d.confirm, d.cleanup) == pytest.approx((100.06, 100.3, 100.4, 100.46, 100.5))
    # 기존 상수는 TOTAL=25 표에서 파생한 별칭(독립 고정값 아님)
    assert adapter_mod.STANDALONE_UPLOAD_BUDGET_S == pytest.approx(split["prep"] * 25.0)
    assert adapter_mod.STANDALONE_TEXT_RESERVE_S == pytest.approx((split["confirm"] - split["prep"]) * 25.0)


def test_localhost_normalized_to_ip_literal_only():
    from ohmyslack.adapter import _standalone_base, resolve_bot_url
    assert _standalone_base("http://localhost:8790") == "http://127.0.0.1:8790"
    assert _standalone_base("http://127.0.0.1:8790") == "http://127.0.0.1:8790"
    with pytest.raises(ValueError):  # 허용 목록은 그대로 — 루프백 밖은 정규화 전에 거부
        resolve_bot_url({"url": "http://example.com:8790"})
