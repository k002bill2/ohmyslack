"""N-2: standalone 실패의 재시도 표시. 어떤 청크도 POST 시도(`attempted`)에 들어가지 않은 실패만 Hermes
`send_error(..., nothing_sent=True)`(→ `retryable: True`), POST를 한 번이라도 시도한 실패는 plain `send_error`."""

from __future__ import annotations

from conftest import CHANNEL_ID, DM_ID, TOKEN


def _cfg(server):
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True, token=TOKEN, extra={"url": server.base})


async def test_failure_before_any_post_is_retryable(server):
    """대상 거부(`/me`에서 DM·allowlist 채널 아님) — 업로드·게시 0 → retryable."""
    from ohmyslack.adapter import standalone_send
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    out = await standalone_send(_cfg(server), CHANNEL_ID, "브리핑")
    assert "error" in out and "success" not in out
    assert out.get("retryable") is True
    assert server.posts == [] and server.uploads == []


async def test_failure_after_post_attempt_is_not_retryable(server):
    """첫 게시가 확정 4xx(403)여도 POST를 시도했으므로 retryable 없음(중복 없음 증거를 요구하지 않는 쪽으로 보수)."""
    from ohmyslack.adapter import standalone_send
    server.post_status = [403]
    out = await standalone_send(_cfg(server), DM_ID, "브리핑")
    assert "error" in out and "success" not in out
    assert "retryable" not in out
    assert len(server.posts) == 1 and server.posts[0]["_status"] == 403


async def test_old_hermes_without_nothing_sent_kw_falls_back_to_plain(server, monkeypatch):
    """구 Hermes(`send_error(message)`만) — TypeError 폴백으로 plain 오류, 예외 전파 0."""
    import gateway.platforms._shared as shared
    from ohmyslack.adapter import standalone_send

    def old_send_error(message):
        return {"error": str(message)}
    monkeypatch.setattr(shared, "send_error", old_send_error)
    server.conversations = [{"id": DM_ID, "kind": "dm"}, {"id": CHANNEL_ID, "kind": "channel"}]
    out = await standalone_send(_cfg(server), CHANNEL_ID, "브리핑")
    assert set(out) == {"error"} and out["error"].startswith("ohmyslack standalone send: ")
    assert server.posts == []
