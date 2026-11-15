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
        self._lock = threading.Lock()  # 등록(loop·event)과 sticky 표지 확인을 release와 직렬화
        self._released = False
        self._loop = None
        self._event = None

    async def wait(self) -> None:
        event = asyncio.Event()
        with self._lock:
            self._loop, self._event = asyncio.get_running_loop(), event
            if self._released:  # 등록 전에 온 release도 잃지 않는다
                event.set()
        self.entered.set()
        await event.wait()

    def release(self) -> None:
        with self._lock:
            self._released = True
            loop, event = self._loop, self._event
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:  # 그 사이 루프가 닫힘
                pass


def _cancel_runner(ctl: dict) -> None:
    """watchdog 최후 수단: runner 루프의 모든 task에 cancel을 넘긴다(협조적 대기만 풀린다 — 강제 종료 아님).
    asyncio.run이 남은 task를 취소·drain한 뒤 루프를 닫는다."""
    loop = ctl.get("loop")
    if loop is None or loop.is_closed():
        return
    try:
        loop.call_soon_threadsafe(lambda: [t.cancel() for t in asyncio.all_tasks(loop)])
    except RuntimeError:  # 그 사이 루프가 닫힘 — 이미 끝남
        pass


def _run_bounded(coro_fn, hang: _Hang, limit: float):
    """daemon 스레드 asyncio.run → (alive_after_limit, box).
    box: out | exc, elapsed(코루틴 안 측정), wall(thread.start 직전 → join 성공 직후), leftover(종료 시 미완료 task)."""
    box: dict = {}
    ctl: dict = {}

    def target() -> None:
        async def main():
            ctl["loop"] = asyncio.get_running_loop()
            began = time.monotonic()
            try:
                box["out"] = await coro_fn()
            finally:
                box["elapsed"] = time.monotonic() - began
                me = asyncio.current_task()
                box["leftover"] = [t for t in asyncio.all_tasks() if t is not me and not t.done()]
        try:
            asyncio.run(main())
        except BaseException as exc:  # noqa: BLE001 — 스레드 밖으로 결과를 옮긴다
            box["exc"] = exc
    runner = threading.Thread(target=target, name="standalone-deadline", daemon=True)
    started = time.monotonic()
    runner.start()
    try:
        runner.join(limit)
        alive = runner.is_alive()
        if not alive:
            box["wall"] = time.monotonic() - started
    finally:
        hang.release()
        runner.join(1.0)
        if runner.is_alive():  # release로 안 풀리는 협조적 대기(진입 전 조기 실패 등) — 루프 task를 취소·drain
            _cancel_runner(ctl)
            runner.join(5.0)
    assert not runner.is_alive(), "watchdog release/cancel did not end the runner thread"
    return alive, box


async def _cancel_after_entry(coro, hang: _Hang):
    """`hang` 진입을 기다렸다가 바깥에서 취소한다(Hermes wait_for 흉내). 'cancelled' | 'swallowed'."""
    task = asyncio.ensure_future(coro)
    try:
        while not hang.entered.is_set() and not task.done():
            await asyncio.sleep(0)
        if task.done():  # 진입 전 종료(조기 실패 등) — 실제 결과·예외를 그대로 낸다
            return await task
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return "cancelled"
        return "swallowed"
    finally:
        if not task.done():  # 바깥 취소·예외로 빠져도 생성 task를 회수(예외는 삼키지 않고 task 안에 둔다)
            task.cancel()
            await asyncio.wait({task})


@pytest.fixture
def total(monkeypatch):
    import ohmyslack.adapter as adapter_mod
    monkeypatch.setattr(adapter_mod, "STANDALONE_TOTAL_DEADLINE_S", TOTAL)
    return TOTAL


class _Session:
    """aiohttp 세션 위임 + close 동작 교체(`hang` 또는 `error`)."""

    def __init__(self, inner, *, hang: _Hang | None = None, error: Exception | None = None,
                 stubborn: bool = False) -> None:
        self._inner, self._hang, self._error, self._stubborn = inner, hang, error, stubborn
        self.close_calls = self.suppressed = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def close(self) -> None:
        self.close_calls += 1
        try:
            while self._hang is not None:
                try:
                    await self._hang.wait()
                    break
                except asyncio.CancelledError:
                    if not self._stubborn:  # 비협조 close 흉내만 취소를 억제한다(보장 밖 측정용)
                        raise
                    self.suppressed += 1
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

    alive, box = _run_bounded(lambda: _cancel_after_entry(adapter_mod.standalone_send(
        _cfg(thread_server.base), DM_ID, "브리핑", session_factory=_factory(sessions)), hang),
        hang, total + WATCHDOG_SLACK)
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


# --- 단계 6 수정: 테스트 수명주기 안전(P2) + 같은 시간 계약의 미실측 분기 ---

N8_WATCHDOG_SLACK = 5.0  # 실제 TOTAL 25초 테스트의 독립 회수 여유(상한 단언은 BOUND_SLACK 그대로)


def test_factory_failure_before_entry_ends_with_real_exception(thread_server, total):
    """P2 회귀: /me 진입 전 조기 실패면 진입 대기가 task 종료를 보고 실제 예외로 끝난다(무한 대기 X)."""
    import ohmyslack.adapter as adapter_mod
    hang = _Hang()

    def broken_factory():
        raise RuntimeError("factory boom")
    alive, box = _run_bounded(lambda: _cancel_after_entry(adapter_mod.standalone_send(
        _cfg(thread_server.base), DM_ID, "브리핑", session_factory=broken_factory), hang),
        hang, total + WATCHDOG_SLACK)
    assert not alive and not hang.entered.is_set()
    assert isinstance(box.get("exc"), RuntimeError) and str(box["exc"]) == "factory boom"
    assert box["leftover"] == [] and thread_server.posts == []


def test_hang_release_before_wait_is_kept():
    """`release()`가 wait의 event 초기화 전에 와도 잃지 않는다(sticky)."""
    hang = _Hang()
    hang.release()
    alive, box = _run_bounded(hang.wait, hang, WATCHDOG_SLACK)
    assert not alive and "exc" not in box and box["leftover"] == []


def test_hang_release_racing_wait_registration_is_not_lost():
    """다른 스레드의 release와 wait 등록을 barrier로 겹친다 — 어느 순서든 wait가 풀린다."""
    for _ in range(20):
        hang, gate = _Hang(), threading.Barrier(2)

        def release_at_gate(h=hang, g=gate) -> None:
            g.wait(5.0)
            h.release()
        releaser = threading.Thread(target=release_at_gate, name="hang-releaser", daemon=True)
        releaser.start()

        async def racer(h=hang, g=gate) -> None:
            await asyncio.to_thread(g.wait, 5.0)
            await h.wait()
        try:
            alive, box = _run_bounded(racer, hang, 1.0)
        finally:
            gate.abort()  # 실패 경로에서도 releaser가 barrier에 남지 않게
            releaser.join(5.0)
        assert not releaser.is_alive(), "releaser thread leaked"
        assert not alive and "exc" not in box and box["leftover"] == []


def test_outer_total_timeout_keeps_attempted_as_delivery_unknown(thread_server, total, monkeypatch):
    """바깥 asyncio.timeout(TOTAL) 분기 실제 진입: 주입 clock(첫 호출=t0, 이후 과거)이라 몫별 left()가 줄지 않아
    내부 post deadline은 안 걸리고 바깥 timer만 끊는다. 표지: 확인 GET 0회(내부 post 분기는 1회) + elapsed ≥ TOTAL."""
    import ohmyslack.adapter as adapter_mod
    hang, calls = _Hang(), []

    async def stuck_post(self, *args, **kwargs):
        await hang.wait()
    monkeypatch.setattr(adapter_mod.BotClient, "post_message", stuck_post)

    def frozen_clock() -> float:
        calls.append(None)
        return 0.0 if len(calls) == 1 else -1000.0
    alive, box = _run_bounded(lambda: adapter_mod.standalone_send(_cfg(thread_server.base), DM_ID, "브리핑",
                                                                  clock=frozen_clock),
                              hang, total + WATCHDOG_SLACK)
    assert not alive and hang.entered.is_set() and "exc" not in box, box.get("exc")
    assert total <= box["elapsed"] <= total + BOUND_SLACK
    assert "delivery_unknown chunk 1/1" in box["out"]["error"]
    assert thread_server.history_calls == 0  # 가드: 내부 post deadline 분기(확인 GET 1회)로 새면 실패


def test_external_cancel_during_cleanup_propagates_and_closes_once(thread_server, total):
    """cleanup(session.close) 도중 외부 취소는 전파되고 close는 정확히 1회. 가드: 삼키면 'swallowed'."""
    from ohmyslack.adapter import standalone_send
    hang, sessions = _Hang(), []
    alive, box = _run_bounded(lambda: _cancel_after_entry(standalone_send(
        _cfg(thread_server.base), DM_ID, "브리핑", session_factory=_factory(sessions, hang=hang)), hang),
        hang, total + WATCHDOG_SLACK)
    assert not alive and box.get("out") == "cancelled"
    assert hang.entered.is_set() and len(sessions) == 1 and sessions[0].close_calls == 1
    assert len(_ok_posts(thread_server)) == 1 and box["leftover"] == []


def test_n8_actual_total25_close_hang_wallclock(thread_server):
    """N8 실측: TOTAL 기본 25초 그대로, 협조적 무기한 close. wall = thread.start 직전 → join 성공 직후."""
    import ohmyslack.adapter as adapter_mod
    actual = adapter_mod.STANDALONE_TOTAL_DEADLINE_S
    assert actual == 25.0
    hang, sessions = _Hang(), []
    alive, box = _run_bounded(lambda: adapter_mod.standalone_send(_cfg(thread_server.base), DM_ID, "아침 브리핑",
                                                                  session_factory=_factory(sessions, hang=hang)),
                              hang, actual + N8_WATCHDOG_SLACK)
    print(f"N8-RAW total={actual} wall={box.get('wall')!r} elapsed={box.get('elapsed')!r} alive={alive}")
    assert not alive and "wall" in box and "exc" not in box, box.get("exc")
    assert box["wall"] <= actual + BOUND_SLACK
    assert box["out"].get("success") is True and len(_ok_posts(thread_server)) == 1
    assert hang.entered.is_set() and sessions[0].close_calls == 1 and box["leftover"] == []


def test_noncooperative_close_overruns_total_outside_guarantee(thread_server, total):
    """보장 밖 측정(PASS 상한 정책 아님): 취소를 억제하는 close는 TOTAL을 넘긴다. 독립 timer가 유한 시점에 풀어 누수 0."""
    from ohmyslack.adapter import standalone_send
    hang, sessions = _Hang(), []
    release_at = total + 1.0
    timer = threading.Timer(release_at, hang.release)
    timer.daemon = True
    timer.start()
    try:
        alive, box = _run_bounded(lambda: standalone_send(_cfg(thread_server.base), DM_ID, "브리핑",
                                                          session_factory=_factory(sessions, hang=hang, stubborn=True)),
                                  hang, release_at + WATCHDOG_SLACK)
    finally:
        timer.cancel()
        timer.join(5.0)
    print(f"NONCOOP-RAW total={total} release_at={release_at} wall={box.get('wall')!r} "
          f"elapsed={box.get('elapsed')!r} suppressed={sessions[0].suppressed if sessions else None}")
    assert not alive and not timer.is_alive() and box["leftover"] == []
    assert box["elapsed"] > total + BOUND_SLACK
    assert sessions[0].close_calls == 1 and sessions[0].suppressed >= 1
