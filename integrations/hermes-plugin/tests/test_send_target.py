"""Issue #49: `send_message` 대상 `ohmyslack:<conversation UUID>` — 플러그인 `target_ref_syntax_fn` 등록.

Hermes 실제 코드(`gateway.outbound.send._resolve_tool_target`·`_handle_send`, `gateway.outbound.targets.resolve_send_target`,
`gateway.relay.egress.authorize_relay_target`)를 그대로 부른다. 대체하는 것:
- `_live_adapter` = (None, None), 플러그인 디스커버리 끔 — 게이트웨이 밖(CLI·cron) 상태(test_standalone_entrypoint.py와 같은 이유).
- `gateway.relay.egress._live_relay_fronted` — 「이 프로세스에 게이트웨이 runner 없음」(None) 또는 대조군에서 「relay가
  ohmyslack을 대신 보냄」({"ohmyslack"}). sandbox에서는 `gateway.run` import가 실패해 실제 함수가 RelayRouteUnknown을
  던지므로(inputs/probe49d.txt:11-74,130-131) 이 한 점만 바꾼다.
`parse_send_target`은 테스트 함수 안에서 import한다 — base `__init__.py`(파서 없음)에서도 「기존 동작 유지」 테스트가 수집·통과하게.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path

import pytest

from conftest import BOT_ID, CHANNEL_ID, DM_ID, TOKEN

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
LONG_TEXT = "가" * 9000  # 어댑터 내부 청크 3개(4000 code point 단위)


@pytest.fixture(autouse=True)
def _outside_gateway(monkeypatch):
    """게이트웨이 밖(cron·CLI)과 같은 상태: 라이브 어댑터 조회 = (None, None), 플러그인 디스커버리 끔."""
    import gateway.outbound.send as smt
    import gateway.outbound.senders as senders
    no_discover = functools.partial(senders._plugin_standalone_sender, discover=False)
    for mod in (smt, senders):  # send는 senders 함수를 같은 객체로 import한다 — 두 모듈에 같은 대체물
        monkeypatch.setattr(mod, "_live_adapter", lambda platform, *_a, **_kw: (None, None))
        monkeypatch.setattr(mod, "_plugin_standalone_sender", no_discover)


def _no_gateway_runner(monkeypatch, fronted=None) -> None:
    """`_live_relay_fronted`만 바꾼다. None = 게이트웨이 runner 없음(inputs/probe49d.txt:49-51) → 실제 경로는 설정 기반
    `relay_fronted_platforms()`(격리 HOME에서 set(), inputs/probe49d.txt:128-129). 집합 = relay가 그 플랫폼을 대신 보냄."""
    import gateway.relay.egress as egress
    monkeypatch.setattr(egress, "_live_relay_fronted", lambda: fronted)


def _bot_env(monkeypatch, base: str, *, home: bool = False) -> None:
    """실제 로더(`load_gateway_config`)가 ohmyslack PlatformConfig를 만들게 env만 넣는다(inputs/probe49c.txt:195-198)."""
    monkeypatch.setenv("OHMYSLACK_BOT_TOKEN", TOKEN)
    monkeypatch.setenv("OHMYSLACK_BOT_URL", base)
    if home:
        monkeypatch.setenv("OHMYSLACK_HOME_CHANNEL", DM_ID)


def _spy(monkeypatch) -> list:
    """레지스트리 standalone sender 호출(chat_id, 첨부)을 기록한다(실제 sender는 그대로 실행)."""
    from gateway.platform_registry import platform_registry
    entry = platform_registry.get("ohmyslack")
    real = entry.standalone_sender_fn
    calls: list = []

    async def spy(pconfig, chat_id, message, **kwargs):
        calls.append((chat_id, list(kwargs.get("media_files") or [])))
        return await real(pconfig, chat_id, message, **kwargs)
    monkeypatch.setattr(entry, "standalone_sender_fn", spy)
    return calls


def _ok_posts(server):
    return [p for p in server.posts if p["_status"] == 200]


def _mp3(tmp_path: Path) -> str:
    path = tmp_path / "briefing.mp3"
    path.write_bytes(MP3)
    return str(path)


def _handle_send(target: str, message: str) -> dict:
    import gateway.outbound.send as smt
    return json.loads(smt._handle_send({"action": "send", "target": target, "message": message}))


# 1 파서 단위 ----------------------------------------------------------------------------------------
def test_parser_accepts_conversation_uuid_as_canonical_lowercase():
    from ohmyslack import parse_send_target
    assert parse_send_target(DM_ID) == (DM_ID, None)
    assert parse_send_target(DM_ID.upper()) == (DM_ID, None)  # `/me` 정확 일치 판정 때문에 소문자 표준형
    assert parse_send_target(f"  {DM_ID}\t") == (DM_ID, None)


@pytest.mark.parametrize("ref", [
    f"{DM_ID}:{DM_ID}",  # 스레드 형식은 지원하지 않는다
    "general", "123", "",
    DM_ID.replace("-", ""),  # 하이픈 없는 32 hex
    "{" + DM_ID + "}",
    f"urn:uuid:{DM_ID}",
])
def test_parser_rejects_non_conversation_refs(ref):
    from ohmyslack import parse_send_target
    assert parse_send_target(ref) is None


# 2 등록 ---------------------------------------------------------------------------------------------
def test_platform_kwargs_register_syntax_parser():
    from ohmyslack import platform_kwargs
    kwargs = platform_kwargs()
    assert callable(kwargs.get("target_ref_syntax_fn"))
    assert kwargs["target_ref_syntax_fn"](DM_ID) == (DM_ID, None)


def test_platform_kwargs_leave_strict_parser_and_validator_unset():
    """`parse_target_ref_fn`을 등록하면 cron이 엄격해진다(inputs/probe49.txt:110-117) — 키 자체가 없어야 한다."""
    from gateway.platform_registry import platform_registry
    from ohmyslack import platform_kwargs
    kwargs = platform_kwargs()
    assert "parse_target_ref_fn" not in kwargs and "validate_target_ref_fn" not in kwargs
    assert platform_registry.get("ohmyslack").parse_target_ref_fn is None


# 3 도구 대상 해석(실제 `_resolve_tool_target`) --------------------------------------------------------
def test_tool_target_resolves_conversation_uuid():
    from gateway.outbound.send import _resolve_tool_target
    assert _resolve_tool_target(f"ohmyslack:{DM_ID}") == ("ohmyslack", DM_ID, None, None)
    assert _resolve_tool_target(f"ohmyslack:{DM_ID.upper()}") == ("ohmyslack", DM_ID, None, None)


@pytest.mark.parametrize("ref", [f"{DM_ID}:{DM_ID}", "general"])
def test_tool_target_unrecognized_refs_still_error(ref):
    from gateway.outbound.send import _resolve_tool_target
    platform_name, chat_id, _thread, error = _resolve_tool_target(f"ohmyslack:{ref}")
    assert platform_name == "ohmyslack" and chat_id is None
    assert error and "Could not resolve" in error


# 4 cron 대상 해석(`pass_unresolved_references=True`, inputs/probe49b.txt:150-161) ------------------------
def test_cron_target_uuid_and_thread_form_pass_through():
    from gateway.outbound.targets import resolve_send_target
    assert resolve_send_target("ohmyslack", DM_ID, pass_unresolved_references=True) == (DM_ID, None, None)
    # 스레드 형식은 원문 그대로 어댑터로 — cron이 엄격해지지 않았음(inputs/probe49c.txt:204-206)
    assert resolve_send_target("ohmyslack", f"{DM_ID}:{DM_ID}", pass_unresolved_references=True) == \
        (f"{DM_ID}:{DM_ID}", None, None)


# 5 `_handle_send` 명시 대상 실경로 -------------------------------------------------------------------
def test_handle_send_explicit_dm_target_without_home_channel(thread_server, tmp_path, monkeypatch):
    """동기 진입점(`_run_async`가 루프를 돌림) → sync 테스트 + 별도 스레드 가짜 서버. 홈 채널 env 없음."""
    _bot_env(monkeypatch, thread_server.base)
    _no_gateway_runner(monkeypatch)
    calls = _spy(monkeypatch)
    mp3 = _mp3(tmp_path)
    out = _handle_send(f"ohmyslack:{DM_ID}", f"{LONG_TEXT}\nMEDIA:{mp3}")
    assert out.get("success") is True, out
    assert "note" not in out  # 홈 채널로 보낸 것이 아니다
    assert len(calls) == 1 and calls[0][0] == DM_ID
    assert len(thread_server.uploads) == 1
    posts = _ok_posts(thread_server)
    assert len(posts) == 3
    assert posts[0]["attachment_ids"] == [thread_server.uploads[0]["attachment_id"]]
    assert all("attachment_ids" not in p for p in posts[1:])  # 첨부는 첫 청크에만
    assert all(p["conversation_id"] == DM_ID for p in posts)


def test_handle_send_uppercase_target_posts_to_canonical_dm(thread_server, monkeypatch):
    _bot_env(monkeypatch, thread_server.base)
    _no_gateway_runner(monkeypatch)
    calls = _spy(monkeypatch)
    out = _handle_send(f"ohmyslack:{DM_ID.upper()}", "아침 브리핑")
    assert out.get("success") is True, out
    assert len(calls) == 1 and calls[0][0] == DM_ID
    posts = _ok_posts(thread_server)
    assert len(posts) == 1 and posts[0]["conversation_id"] == DM_ID  # 게시 경로의 대화 id = 소문자 표준형


# 6 채널 대상(받는 쪽 규칙은 기존 그대로: DM 또는 OHMYSLACK_POST_CHANNELS) ------------------------------------
def test_handle_send_channel_target_without_allowlist_is_refused_by_sender(thread_server, tmp_path, monkeypatch):
    _bot_env(monkeypatch, thread_server.base)
    _no_gateway_runner(monkeypatch)
    thread_server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    calls = _spy(monkeypatch)
    out = _handle_send(f"ohmyslack:{CHANNEL_ID}", f"아침 브리핑\nMEDIA:{_mp3(tmp_path)}")
    assert out.get("success") is not True
    assert len(calls) == 1 and calls[0][0] == CHANNEL_ID  # 해석은 됐고 sender가 거부했다
    assert "target must be the owner DM or an allowlisted channel" in out.get("error", "")
    assert thread_server.uploads == [] and thread_server.posts == []


def test_handle_send_allowlisted_channel_target_folds_chunks_into_thread(thread_server, tmp_path, monkeypatch):
    """기대값은 tests/test_standalone_attach.py:321-337(allowlist 채널 + 긴 본문 + 첨부)과 같다."""
    _bot_env(monkeypatch, thread_server.base)
    _no_gateway_runner(monkeypatch)
    monkeypatch.setenv("OHMYSLACK_POST_CHANNELS", CHANNEL_ID)
    thread_server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    out = _handle_send(f"ohmyslack:{CHANNEL_ID}", f"{LONG_TEXT}\nMEDIA:{_mp3(tmp_path)}")
    assert out.get("success") is True and not out.get("warnings"), out
    ok = _ok_posts(thread_server)
    assert len(ok) >= 3 and all(p["conversation_id"] == CHANNEL_ID for p in ok)
    first_id = thread_server.idem[(CHANNEL_ID, BOT_ID, ok[0]["client_message_id"])]["id"]
    assert ok[0].get("thread_root_id") is None and len(ok[0].get("attachment_ids") or []) == 1
    assert all(p.get("thread_root_id") == first_id and not p.get("attachment_ids") for p in ok[1:])


# 7 relay 가드 대조군 — 실제 `_authorize_relay_target`·`authorize_relay_target`가 돈다 ---------------------
def _relay_fronts_ohmyslack(monkeypatch, server) -> list:
    """relay가 ohmyslack을 대신 보내는 배치. 채널은 받는 쪽 규칙상 보낼 수 있게 열어 둔다 — 게시 0이 가드 때문임을 보장."""
    _bot_env(monkeypatch, server.base, home=True)
    _no_gateway_runner(monkeypatch, fronted={"ohmyslack"})
    monkeypatch.setenv("OHMYSLACK_POST_CHANNELS", CHANNEL_ID)
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    return _spy(monkeypatch)


def test_relay_guard_refuses_unattested_explicit_target(thread_server, monkeypatch):
    calls = _relay_fronts_ohmyslack(monkeypatch, thread_server)
    out = _handle_send(f"ohmyslack:{CHANNEL_ID}", "아침 브리핑")
    assert out.get("success") is not True
    assert "unattested relay target" in out.get("error", ""), out
    assert calls == [] and thread_server.posts == []


def test_relay_guard_allows_home_channel_target(thread_server, monkeypatch):
    calls = _relay_fronts_ohmyslack(monkeypatch, thread_server)
    out = _handle_send("ohmyslack", "아침 브리핑")  # 홈 채널 = 운영자가 설정한 증명 대상
    assert out.get("success") is True, out
    assert len(calls) == 1 and calls[0][0] == DM_ID
    assert len(_ok_posts(thread_server)) == 1
