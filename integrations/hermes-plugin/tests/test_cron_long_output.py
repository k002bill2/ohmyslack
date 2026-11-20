"""cron 긴 출력 — live 레인에서 잘리지 않고 나뉘어 게시되는지(cron-long-split).

원인(L1): cron live 레인(`cron/scheduler_delivery.py` `_live_send_text`)은 `DeliveryRouter._deliver_to_platform`을
부르고, 라우터는 `_cap_oversized_output`에서 `splits_long_messages`가 False인 어댑터에 대해 4,000자 초과 본문을
`... [truncated, full output saved to …]` 표지로 자른다(`gateway/delivery.py`). 어댑터가 이 속성을 True로 선언하면
라우터는 전문을 넘기고, 어댑터 `send`가 `truncate_message(…, 4000)`로 나눠 게시한다.
여기서는 그 실제 라우터 함수를 가짜 봇 서버 + 실제 어댑터로 호출한다.
"""

from __future__ import annotations

import re

import pytest

from conftest import DM_ID, make_message

MARKER = "truncated, full output saved to"
_INDICATOR = re.compile(r" \((\d+)/(\d+)\)$")
JOB_ID = "job-cron-long"


def _body(n: int) -> str:
    # 공백·개행 없는 한글+ASCII 본문: 분할 지점의 lstrip이 문자를 지우지 않아 이어 붙임이 원문과 정확히 같다.
    unit = "가나다라마바사아자차카타파하abc123"
    return (unit * (n // len(unit) + 1))[:n]


def _ok(server):
    return [p for p in server.posts if p["_status"] == 200]


def _strip_indicators(bodies: list[str]) -> list[str]:
    if len(bodies) == 1:
        return bodies
    out = []
    for i, body in enumerate(bodies):
        m = _INDICATOR.search(body)
        assert m and int(m.group(1)) == i + 1 and int(m.group(2)) == len(bodies), body[-20:]
        out.append(body[:m.start()])
    return out


async def _deliver_as_cron(adapter, content: str, thread_id=None):
    """cron live 레인이 부르는 것과 같은 `DeliveryRouter._deliver_to_platform`(cron 메타 `job_id` 포함)."""
    from gateway.config import GatewayConfig, Platform
    from gateway.delivery import DeliveryRouter, DeliveryTarget, DeliveryTransport
    platform = Platform("ohmyslack")
    router = DeliveryRouter(GatewayConfig(), {platform: adapter})
    target = DeliveryTarget(platform=platform, chat_id=DM_ID, thread_id=thread_id, is_explicit=True)
    transport = DeliveryTransport(adapter, None, platform)
    result = await router._deliver_to_platform(target, content, {"job_id": JOB_ID}, transport=transport)
    return router, result


def test_adapter_declares_native_splitting():
    from ohmyslack.adapter import OhmySlackAdapter
    assert OhmySlackAdapter.splits_long_messages is True


async def test_cron_long_output_is_split_not_truncated(server, make_adapter):
    adapter = make_adapter()
    assert await adapter.connect()
    original = _body(9000)
    router, result = await _deliver_as_cron(adapter, original)
    assert getattr(result, "success", False)
    bodies = [p["body"] for p in _ok(server)]
    assert len(bodies) >= 3
    assert all(len(b) <= 4000 for b in bodies)  # Python str 길이 = code point
    assert not any(MARKER in b for b in bodies)
    assert "".join(_strip_indicators(bodies)) == original
    # DM 최상위는 연속 최상위 게시(스레드 루트 없음).
    assert all(p.get("thread_root_id") is None for p in _ok(server))
    # 4,000 초과 cron 출력의 오디트 저장은 그대로 남는다(라우터 동작 불변).
    saved = list(router.output_dir.glob(f"{JOB_ID}_*.txt"))
    assert len(saved) == 1 and saved[0].read_text(encoding="utf-8") == original


async def test_cron_long_output_in_thread_stays_in_thread(server, make_adapter):
    server.add(make_message(mid="root-9"))  # 봇에게 보이는 루트(가짜 서버 루트 가시성 404, test_outbound.py:75와 같은 준비)
    adapter = make_adapter()
    assert await adapter.connect()
    original = _body(9000)
    _, result = await _deliver_as_cron(adapter, original, thread_id="root-9")
    assert getattr(result, "success", False)
    ok = _ok(server)
    assert len(ok) >= 3 and all(p["thread_root_id"] == "root-9" for p in ok)
    assert not any(MARKER in p["body"] for p in ok)
    assert "".join(_strip_indicators([p["body"] for p in ok])) == original


@pytest.mark.parametrize("n,posts", [(4000, 1), (4001, 2)])
async def test_cron_output_boundaries(server, make_adapter, n, posts):
    adapter = make_adapter()
    assert await adapter.connect()
    original = _body(n)
    _, result = await _deliver_as_cron(adapter, original)
    assert getattr(result, "success", False)
    bodies = [p["body"] for p in _ok(server)]
    assert len(bodies) == posts
    assert all(len(b) <= 4000 for b in bodies)
    assert not any(MARKER in b for b in bodies)
    assert "".join(_strip_indicators(bodies)) == original
