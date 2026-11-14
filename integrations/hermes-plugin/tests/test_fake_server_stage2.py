"""가짜 봇 서버 자체 계약(설계 r4 §4 단계 2) — 멱등 replay·409·첨부 재결속 400·이력 GET·장애 주입.

Hermes·플러그인 import 없음: aiohttp 클라이언트로 가짜 서버만 직접 친다. 서버 대조 근거는 레인 REPORT.
"""

from __future__ import annotations

import json
import uuid

import aiohttp
import pytest

from conftest import BOT_ID, DM_ID, TOKEN, make_message

API = "/api/bot/v1"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


async def _post(server, payload: dict, *, cid: str = DM_ID, redirects: bool = False):
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.post(f"{server.base}{API}/conversations/{cid}/messages", json=payload,
                          allow_redirects=redirects) as resp:
            return resp.status, await resp.read()


async def _history(server, limit=None, cid: str = DM_ID):
    q = "" if limit is None else f"?limit={limit}"
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.get(f"{server.base}{API}/conversations/{cid}/messages{q}", allow_redirects=False) as resp:
            return resp.status, await resp.read()


def _payload(key: str, body: str = "hi", **extra) -> dict:
    return {"client_message_id": key, "body": body, **extra}


def _stored(server, key: str) -> list[dict]:
    return [m for _c, _conv, m in server.changes if m.get("client_message_id") == key and m["author_id"] == BOT_ID]


async def test_fake_replay_same_key_returns_original(server):
    key = str(uuid.uuid4())
    st1, b1 = await _post(server, _payload(key))
    st2, b2 = await _post(server, _payload(key))
    assert (st1, st2) == (201, 200)
    first, again = json.loads(b1), json.loads(b2)
    assert again["message"]["id"] == first["message"]["id"]
    assert again["change_id"] == first["change_id"]
    assert len(_stored(server, key)) == 1
    # 같은 키라도 다른 대화면 별개 범위(cid, author, key) → 새로 저장.
    other = str(uuid.UUID(int=101))
    server.conversations.append({"id": other, "kind": "dm"})
    st3, _ = await _post(server, _payload(key), cid=other)
    assert st3 == 201


async def test_fake_conflict_on_payload_change(server):
    key = str(uuid.uuid4())
    assert (await _post(server, _payload(key, "a")))[0] == 201
    for changed in (_payload(key, "b"), _payload(key, "a", thread_root_id=str(uuid.uuid4())),
                    _payload(key, "a", attachment_ids=[str(uuid.uuid4())]),
                    _payload(key, "a", mention_user_ids=[str(uuid.UUID(int=2))])):
        st, body = await _post(server, changed)
        assert (st, json.loads(body)) == (409, {"error": "idempotency_conflict"}), changed
    assert len(_stored(server, key)) == 1


async def test_fake_replay_skips_body_check_after_delete(server):
    key = str(uuid.uuid4())
    _st, b1 = await _post(server, _payload(key, "a"))
    server.tombstone(json.loads(b1)["message"]["id"])
    st, body = await _post(server, _payload(key, "different"))
    assert st == 200 and json.loads(body)["message"]["deleted_at"] is not None


async def test_fake_rebinding_attachment_is_400(server):
    aid = str(uuid.uuid4())
    assert (await _post(server, _payload(str(uuid.uuid4()), attachment_ids=[aid])))[0] == 201
    st, body = await _post(server, _payload(str(uuid.uuid4()), attachment_ids=[aid]))
    assert (st, json.loads(body)) == (400, {"error": "invalid_attachments"})


async def test_fake_history_returns_key(server):
    keys = [str(uuid.uuid4()) for _ in range(3)]
    ids = []
    for i, key in enumerate(keys):
        ids.append(json.loads((await _post(server, _payload(key, f"m{i}")))[1])["message"]["id"])
    server.add(make_message(body="reply", thread_root_id=ids[0]))  # 답글은 이력에 없음
    server.tombstone(ids[1])
    st, body = await _history(server)
    assert st == 200
    page = json.loads(body)
    assert [m["client_message_id"] for m in page["messages"]] == keys  # 오름차순, tombstone 키 보존
    assert page["messages"][1]["deleted_at"] is not None and page["messages"][1]["body"] is None
    assert page["has_more"] is False
    st, body = await _history(server, limit=2)
    assert [m["client_message_id"] for m in json.loads(body)["messages"]] == keys[1:]  # 최신 2개 오름차순
    assert json.loads(body)["has_more"] is True


async def test_fake_post_faults_after_commit(server):
    key = str(uuid.uuid4())
    server.post_disconnect_after_commit = 1
    with pytest.raises(aiohttp.ServerDisconnectedError):
        await _post(server, _payload(key))
    assert len(_stored(server, key)) == 1  # 커밋됨
    server.post_body_fault_after_commit = ["truncated", "invalid"]
    for _ in range(2):
        st, raw = await _post(server, _payload(key))
        assert st == 200
        with pytest.raises(ValueError):
            json.loads(raw)
    server.post_redirect_after_commit = [302]
    st, _raw = await _post(server, _payload(key))
    assert st == 302
    st, raw = await _post(server, _payload(key))
    assert st == 200 and json.loads(raw)["message"]["client_message_id"] == key
    assert len(_stored(server, key)) == 1


async def test_fake_history_faults(server):
    server.history_status = [401, 403]
    assert (await _history(server))[0] == 401
    assert (await _history(server))[0] == 403
    # aiohttp 는 GET(멱등)의 ServerDisconnectedError 를 1회 자동 재시도한다(aiohttp/client.py IDEMPOTENT_METHODS) → 2회 끊어야 보인다.
    server.history_disconnect = 2
    with pytest.raises(aiohttp.ServerDisconnectedError):
        await _history(server)
    server.history_body_fault = ["invalid"]
    st, raw = await _history(server)
    assert st == 200
    with pytest.raises(ValueError):
        json.loads(raw)
    server.history_delay = 0.05
    assert (await _history(server))[0] == 200
    assert server.history_calls == 6
