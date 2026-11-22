"""ADR-002 1a 재작업: standalone 전송을 Hermes **실제 진입점**으로 검증한다(DESIGN p2s1-1a-redesign §5 #1–#10).

`standalone_send`를 직접 부르지 않는다. Hermes `gateway.outbound.send._platform_max_length`·`_send_to_platform`·
`_handle_send`, `cron.scheduler_delivery_standalone._standalone_send`·`cron.scheduler_delivery._deliver_standalone`을
거친다(PYTHONPATH = Hermes 체크아웃, 읽기 전용). Hermes `f8acc268`(11-16)에서 `tools/send_message_tool.py`가
`gateway/outbound/{send,senders,targets}.py`로 옮겨졌다.
Hermes는 sender에 `clock=` 등을 넘길 수 없으므로 시계·deadline은 어댑터 모듈 속성으로 주입한다.
#11(`_handle_send`)은 설정을 env로만 넣고(실제 로더), relay 가드는 `gateway.relay.egress._live_relay_fronted`만 바꾼다.
"""

from __future__ import annotations

import functools
import json
import os
import threading
import time
from pathlib import Path

import pytest

from conftest import DM_ID, TOKEN, FakeClock

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       + b"\x00" * 32)
LONG_TEXT = "가" * 9000  # 어댑터 내부 청크 3개(4000 code point 단위)


@pytest.fixture(autouse=True)
def _standalone_lane(monkeypatch):
    """게이트웨이 밖(cron·CLI)과 같은 상태: 라이브 어댑터 조회 = (None, None).

    실제 `_live_adapter`는 `gateway.run`을 import해 Hermes 부트스트랩(의존성 준비·재실행)을 부르므로 조회 함수만 바꾼다.
    플러그인 디스커버리(`discover_plugins`)도 끈다 — 레지스트리 entry 조회·청킹·`media_files if is_last` 분기는 실제 코드.
    """
    import functools as _ft

    import gateway.outbound.senders as senders
    no_discover = _ft.partial(senders._plugin_standalone_sender, discover=False)
    _patch_outbound(monkeypatch, "_live_adapter", lambda platform, *_a, **_kw: (None, None))
    _patch_outbound(monkeypatch, "_plugin_standalone_sender", no_discover)


def _patch_outbound(monkeypatch, name: str, value) -> None:
    """`send`는 `senders`의 함수를 같은 객체로 import하고, `send._send_via_adapter`·`_send_to_platform`·
    `_send_plugin_standalone`은 send 전역에서, `senders._registry_standalone_send`는 senders 전역에서 이름을 찾는다
    → 두 모듈에 같은 대체물을 건다."""
    import gateway.outbound.send as smt
    import gateway.outbound.senders as senders
    for mod in (smt, senders):
        monkeypatch.setattr(mod, name, value)


def _platform():
    from gateway.config import Platform
    return Platform("ohmyslack")


def _cfg(base: str):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": base})


def _ok_posts(server):
    return [p for p in server.posts if p["_status"] == 200]


def _me_calls(server) -> int:
    return sum(1 for method, path, _h in server.requests if method == "GET" and path.endswith("/me"))


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


async def _send(server, text, media_files=None):
    """Hermes `send_message`·cron 공통 진입점. 게이트웨이가 없으므로 `_live_adapter`는 (None, None) → standalone sender."""
    from gateway.outbound.send import _send_to_platform
    return await _send_to_platform(_platform(), _cfg(server.base), DM_ID, text, media_files=media_files)


def _spy_sender(monkeypatch) -> list:
    """레지스트리에 등록된 standalone sender 호출을 기록한다(실제 sender는 그대로 실행)."""
    from gateway.platform_registry import platform_registry
    entry = platform_registry.get("ohmyslack")
    real = entry.standalone_sender_fn
    calls: list = []

    async def spy(pconfig, chat_id, message, **kwargs):
        calls.append((message, list(kwargs.get("media_files") or [])))
        return await real(pconfig, chat_id, message, **kwargs)
    monkeypatch.setattr(entry, "standalone_sender_fn", spy)
    return calls


def _no_retry_sleep(monkeypatch, sleep=None) -> None:
    import ohmyslack.adapter as adapter_mod

    async def no_sleep(_delay):
        return None
    monkeypatch.setattr(adapter_mod, "BotClient", functools.partial(adapter_mod.BotClient, sleep=sleep or no_sleep))


def _target(base: str, *, live_error=None):
    """cron `_TargetDelivery` 최소 구성(standalone 경로가 읽는 필드만 의미 있음)."""
    from cron.scheduler_delivery import _TargetDelivery
    return _TargetDelivery(
        job={"id": "job-entrypoint"}, platform=_platform(), platform_name="ohmyslack", chat_id=DM_ID,
        thread_id=None, transport=None, pconfig=_cfg(base), runtime_adapter=None, target_adapters=None,
        config={}, loop=None, notify_delivery=False, origin={}, origin_target=False, origin_user_id=None,
        is_dm_target=True, mirror_text="", mirror_this_target=False, in_channel_surface=False,
        inchannel_continuable=False, opened_thread_id=None, live_error=live_error)


# #1 ----------------------------------------------------------------------------------------------
def test_registry_disables_hermes_chunking():
    from gateway.outbound.send import _platform_max_length
    assert _platform_max_length(_platform()) is None  # Hermes가 원문을 쪼개지 않고 sender를 1회 부른다


# #2 ----------------------------------------------------------------------------------------------
async def test_long_text_with_mp3_via_send_to_platform_is_one_sender_call(server, tmp_path, monkeypatch):
    calls = _spy_sender(monkeypatch)
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, LONG_TEXT, [(mp3, True)])
    assert len(calls) == 1 and calls[0][1] == [(mp3, True)]
    assert _me_calls(server) == 1
    assert len(server.uploads) == 1
    posts = _ok_posts(server)
    assert len(posts) == 3
    assert posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]
    assert all("attachment_ids" not in p for p in posts[1:])
    assert out.get("success") is True and out.get("media_delivered") is True and not out.get("warnings")


# #3 ----------------------------------------------------------------------------------------------
async def test_single_deadline_spans_all_chunks(server, tmp_path, monkeypatch):
    import ohmyslack.adapter as adapter_mod
    clock = FakeClock()
    monkeypatch.setattr(adapter_mod, "_clock", clock)
    real_get_me = adapter_mod.BotClient.get_me

    async def slow_get_me(self):
        res = await real_get_me(self)
        clock.now += 16.0  # /me가 16초(prep 몫 15초 초과·post 몫 20초 안) — 외부 청크마다 부르면 deadline을 여러 번 쓴다
        return res
    monkeypatch.setattr(adapter_mod.BotClient, "get_me", slow_get_me)
    _no_retry_sleep(monkeypatch, sleep=clock.sleep)
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    start = clock.now
    out = await _send(server, LONG_TEXT, [(mp3, True)])
    assert clock.now - start <= adapter_mod.STANDALONE_TOTAL_DEADLINE_S
    assert out.get("success") is True
    posts = _ok_posts(server)
    assert len(posts) == 3 or "text: partial_delivery" in " ".join(out.get("warnings") or [])
    assert "briefing.mp3: budget_exceeded" in out["warnings"]  # 텍스트 몫을 먼저 떼어 업로드는 건너뛴다


# #4 ----------------------------------------------------------------------------------------------
def test_cron_standalone_send_returns_within_bound_when_read_hangs(thread_server, tmp_path, monkeypatch):
    """루프 없는 sync 테스트: cron 정상 분기(`asyncio.run` + 60초)를 그대로 탄다(async 안에서는 30초 폴백 분기)."""
    import ohmyslack.adapter as adapter_mod
    from cron.scheduler_delivery_standalone import _standalone_send  # probe module_files.sds
    deadline = 0.5
    monkeypatch.setattr(adapter_mod, "STANDALONE_TOTAL_DEADLINE_S", deadline)
    monkeypatch.setattr(adapter_mod, "STANDALONE_TEXT_RESERVE_S", 0.1)
    entered, release = threading.Event(), threading.Event()

    def stuck_read(*_args, **_kwargs):
        entered.set()
        release.wait()  # 파일 시스템이 무기한 멈춘 상황 — watchdog이 풀어 스위트 hang을 막는다
        return None, "rejected"
    monkeypatch.setattr(adapter_mod, "read_attachment_file", stuck_read)
    watchdog = threading.Timer(5.0, release.set)
    watchdog.daemon = True
    watchdog.start()
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    began = time.monotonic()
    try:
        result, err = _standalone_send(_target(thread_server.base), "아침 브리핑", [(mp3, True)])
        elapsed = time.monotonic() - began
    finally:
        release.set()
        watchdog.cancel()
    assert entered.is_set()  # 읽기가 실제로 시작돼 멈췄다
    assert elapsed <= deadline + 2.0, f"cron standalone send returned after {elapsed:.2f}s"
    assert err is None and result.get("success") is True
    assert "briefing.mp3: budget_exceeded" in result["warnings"]
    assert len(_ok_posts(thread_server)) == 1


# #5 ----------------------------------------------------------------------------------------------
async def test_reject_reason_never_runs_on_loop_thread(server, tmp_path, monkeypatch):
    loop_thread = threading.get_ident()
    missing = str(tmp_path / "gone.mp3")
    big = tmp_path / "huge.mp3"
    with open(big, "wb") as fh:
        fh.truncate(10 * 1024 * 1024 + 1)
    watched = {missing, str(big)}
    fs_threads: list[int] = []

    def spy(real):
        def wrapped(path, *args, **kwargs):
            try:
                key = os.fspath(path)
            except TypeError:
                key = None
            if key in watched:
                fs_threads.append(threading.get_ident())
            return real(path, *args, **kwargs)
        return wrapped
    for name in ("lstat", "stat", "open"):
        monkeypatch.setattr(os, name, spy(getattr(os, name)))
    out = await _send(server, "아침 브리핑", [(missing, True), (str(big), True)])
    assert fs_threads, "file checks must still run (off the loop thread)"
    assert loop_thread not in fs_threads  # 루프 스레드 파일 시스템 호출 0
    assert out.get("success") is True
    assert "gone.mp3: not_found" in out["warnings"] and "huge.mp3: too_large" in out["warnings"]


# #6 ----------------------------------------------------------------------------------------------
async def test_partial_chunk_failure_reports_success_with_warning(server, tmp_path, monkeypatch):
    _no_retry_sleep(monkeypatch)
    server.ok_posts_before_429 = 1  # 첫 게시만 성공, 이후 429가 재시도 상한까지 계속
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, LONG_TEXT, [(mp3, True)])
    assert "error" not in out and out.get("success") is True
    assert "text: partial_delivery 1/3" in out["warnings"]
    assert out.get("media_delivered") is True  # 첨부는 청크 0에 결속됨 — 텍스트 경고와 독립(설계 r4 §Q3 M1)
    posts = _ok_posts(server)
    assert len(posts) == 1 and posts[0]["attachment_ids"] == [server.uploads[0]["attachment_id"]]


# #7 ----------------------------------------------------------------------------------------------
def test_partial_failure_is_not_queued_for_redelivery(thread_server, monkeypatch):
    import gateway.delivery_ledger as ledger
    from cron.scheduler_delivery import _deliver_standalone
    recorded: list = []
    monkeypatch.setattr(ledger, "ledger_enabled", lambda *a, **k: True)
    monkeypatch.setattr(ledger, "record_obligation", lambda **kw: recorded.append(kw))
    monkeypatch.setattr(ledger, "mark_failed", lambda *a, **k: None)
    _no_retry_sleep(monkeypatch)
    thread_server.ok_posts_before_429 = 1
    target_errors: list = []
    delivery_errors: list = []
    _deliver_standalone(_target(thread_server.base, live_error="send_path_degraded"), LONG_TEXT, [],
                        target_errors, delivery_errors)
    assert recorded == []  # 부분 게시 뒤 원문 전체 재전달(중복) 없음
    assert target_errors == []
    assert any("delivery warning: text: partial_delivery 1/3" in e for e in delivery_errors)
    assert len(_ok_posts(thread_server)) == 1


# #8 ----------------------------------------------------------------------------------------------
async def test_first_chunk_failure_still_send_error(server, tmp_path, monkeypatch):
    _no_retry_sleep(monkeypatch)
    server.post_status = [403]
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    out = await _send(server, LONG_TEXT, [(mp3, True)])
    assert "error" in out and not out.get("success")  # 아무것도 안 나갔으므로 재전달 큐가 안전하다
    assert _ok_posts(server) == []


# #9 ----------------------------------------------------------------------------------------------
async def test_live_send_message_full_text_chunked_by_adapter(server, make_adapter, monkeypatch):
    import gateway.outbound.send as smt
    from gateway.platforms.base import BasePlatformAdapter
    adapter = make_adapter()
    assert await adapter.connect()
    _patch_outbound(monkeypatch, "_live_adapter", lambda platform, *_a, **_kw: (None, adapter))
    out = await smt._send_to_platform(_platform(), _cfg(server.base), DM_ID, LONG_TEXT)
    assert out.get("success") is True
    bodies = [p["body"] for p in _ok_posts(server)]
    assert bodies == BasePlatformAdapter.truncate_message(LONG_TEXT, 4000)  # 게시 형태((i/n) 포함) 불변
    assert len(bodies) == 3 and all(len(b) <= 4000 for b in bodies)


# #10 ---------------------------------------------------------------------------------------------
async def test_send_message_tool_media_tags_reach_sender_once(server, tmp_path, monkeypatch):
    from gateway.platforms.base import BasePlatformAdapter
    calls = _spy_sender(monkeypatch)
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    png = _write(tmp_path, "chart.png", PNG)
    media, cleaned = BasePlatformAdapter.extract_media("가" * 4500 + f"\nMEDIA:{mp3}\nMEDIA:{png}")
    assert len(media) == 2
    out = await _send(server, cleaned, media)
    assert len(calls) == 1 and len(calls[0][1]) == 2
    assert out.get("success") is True
    posts = _ok_posts(server)
    assert len(posts) == 2 and len(posts[0]["attachment_ids"]) == 2 and "attachment_ids" not in posts[1]


# #11 ---------------------------------------------------------------------------------------------
def test_handle_send_home_channel_long_text_with_mp3(thread_server, tmp_path, monkeypatch):
    """Hermes `send_message` 도구 진입점 `gateway.outbound.send._handle_send`(동기, JSON 문자열 반환)를 그대로 부른다.

    설정은 대체하지 않는다 — env(`OHMYSLACK_BOT_TOKEN`·`OHMYSLACK_BOT_URL`·`OHMYSLACK_HOME_CHANNEL`)만 넣어 실제
    `load_gateway_config`·`_resolve_platform_config`·`_home_chat_id`·`_resolve_tool_target`·`_send_to_platform`이 돈다
    (inputs/probe49c.txt:195-198; conftest `_isolated_env`가 env를 비우고 HERMES_HOME을 tmp로 격리, tests/conftest.py:49-55).
    대체는 `gateway.relay.egress._live_relay_fronted` 한 점(「게이트웨이 runner 없음」)뿐 — 아래 주석.
    동기 진입점(`_run_async`)이 루프를 돌리므로 sync 테스트 + 별도 스레드 가짜 서버(#4와 같은 이유).
    """
    import gateway.outbound.send as smt
    import gateway.relay.egress as egress
    calls = _spy_sender(monkeypatch)
    # 실제 로더가 ohmyslack PlatformConfig(enabled, extra.url, home_channel)를 만든다. token은 비고 sender가
    # get_scoped_secret으로 읽는다(ohmyslack/adapter.py:1147).
    monkeypatch.setenv("OHMYSLACK_BOT_TOKEN", TOKEN)
    monkeypatch.setenv("OHMYSLACK_BOT_URL", thread_server.base)
    monkeypatch.setenv("OHMYSLACK_HOME_CHANNEL", DM_ID)
    # 대체하는 사실은 「이 프로세스에 게이트웨이 runner 없음」(None, CLI·cron의 정상 답 — inputs/probe49d.txt:49-51) 하나다.
    # 이유: sandbox에서 `gateway.run` import가 실패해 실제 함수가 RelayRouteUnknown을 던지고 가드가 거부한다
    # (inputs/probe49d.txt:11-74,130-131, inputs/probe49c.txt:193-200). 실제로 남는 경로: `_authorize_relay_target` →
    # `authorize_relay_target` → `relay_routed_platform` → 설정 기반 `relay_fronted_platforms()`(set(), probe49d.txt:128-129).
    monkeypatch.setattr(egress, "_live_relay_fronted", lambda: None)
    mp3 = _write(tmp_path, "briefing.mp3", MP3)
    raw = smt._handle_send({"action": "send", "target": "ohmyslack", "message": f"{LONG_TEXT}\nMEDIA:{mp3}"})
    out = json.loads(raw)
    assert out.get("success") is True, out
    assert "home channel" in out.get("note", "")  # 실제 `_home_chat_id` 경로로 홈 채널에 보냈다
    media_paths = [str(m if isinstance(m, (str, os.PathLike)) else m[0]) for m in calls[0][1]] if calls else []
    assert len(calls) == 1 and media_paths == [mp3]  # 단일 호출 계약: 원문 전체·첨부 전체 1회
    assert len(thread_server.uploads) == 1
    posts = _ok_posts(thread_server)
    assert len(posts) == 3  # 청크 수(9000 code point → 4000 단위 3개)
    assert posts[0]["attachment_ids"] == [thread_server.uploads[0]["attachment_id"]]
    assert all("attachment_ids" not in p for p in posts[1:])  # 첨부는 첫 청크에만
    assert len(thread_server.posts) == len(posts)  # 재시도·replay·거부 게시 0
    assert len({p["client_message_id"] for p in posts}) == len(posts)  # 중복 게시 0
