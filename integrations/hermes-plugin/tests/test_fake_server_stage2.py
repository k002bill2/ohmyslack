"""가짜 봇 서버 자체 계약(설계 r4 §4 단계 2) — 멱등 replay·409·첨부 재결속 400·이력 GET·장애 주입.

Hermes·플러그인 import 없음: aiohttp 클라이언트로 가짜 서버만 직접 친다. 서버 대조 근거는 레인 REPORT.
"""

from __future__ import annotations

import json
import uuid

import aiohttp
import pytest

from conftest import BOT_ID, CHANNEL_ID, DM_ID, OTHER_ID, OWNER_ID, TOKEN, make_message

API = "/api/bot/v1"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
NOT_FOUND = {"error": "not_found"}
INVALID_ATTACHMENTS = {"error": "invalid_attachments"}


async def _post(server, payload: dict, *, cid: str = DM_ID, redirects: bool = False):
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.post(f"{server.base}{API}/conversations/{cid}/messages", json=payload,
                          allow_redirects=redirects) as resp:
            return resp.status, await resp.read()


async def _upload(server, cid: str = DM_ID) -> str:
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.post(f"{server.base}{API}/attachments", params={"conversation_id": cid}, data=b"png",
                          headers={"Content-Type": "image/png"}) as resp:
            assert resp.status == 201
            return (await resp.json())["attachment_id"]


async def _patch(server, mid: str, body: str):
    async with aiohttp.ClientSession(headers=AUTH) as s:
        async with s.patch(f"{server.base}{API}/messages/{mid}", json={"body": body}) as resp:
            return resp.status, await resp.read()


def _seed_root(server, conv: str = DM_ID) -> str:
    """봇에게 보이는 원문(루트) — 스레드 충돌·답글 시험용."""
    root = make_message(body="root", conv=conv)
    server.add(root, conv)
    return root["id"]


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
    # 스레드 루트는 존재하고 봇에게 보이는 원문 — 없는 루트는 replay 판정 전에 404(아래 별도 시험).
    for changed in (_payload(key, "b"), _payload(key, "a", thread_root_id=_seed_root(server)),
                    _payload(key, "a", attachment_ids=[str(uuid.uuid4())]),
                    _payload(key, "a", mention_user_ids=[OWNER_ID])):  # OWNER = 생성 시점 활성 참여자
        st, body = await _post(server, changed)
        assert (st, json.loads(body)) == (409, {"error": "idempotency_conflict"}), changed
    assert len(_stored(server, key)) == 1


async def test_fake_missing_or_hidden_root_is_404_before_replay(server):
    key = str(uuid.uuid4())
    assert (await _post(server, _payload(key, "a")))[0] == 201
    hidden = _seed_root(server)
    server.hidden_message_ids.add(hidden)
    for root in (str(uuid.uuid4()), hidden):
        # 새 키·기존 키(replay 후보) 모두 루트 가시성 404가 먼저.
        for k in (str(uuid.uuid4()), key):
            st, body = await _post(server, _payload(k, "a", thread_root_id=root))
            assert (st, json.loads(body)) == (404, NOT_FOUND), (root, k)
    assert len(_stored(server, key)) == 1
    # 다른 대화의 원문도 이 대화에서는 안 보인다.
    st, _ = await _post(server, _payload(str(uuid.uuid4()), thread_root_id=_seed_root(server, CHANNEL_ID)))
    assert st == 404
    st, _ = await _post(server, _payload(str(uuid.uuid4()), thread_root_id=_seed_root(server)))
    assert st == 201


async def test_fake_replay_after_patch_returns_edited_state(server):
    key = str(uuid.uuid4())
    _st, b1 = await _post(server, _payload(key, "a"))
    mid = json.loads(b1)["message"]["id"]
    st, body = await _patch(server, mid, "edited")
    edited = json.loads(body)["message"]
    assert st == 200 and (edited["id"], edited["client_message_id"], edited["body"]) == (mid, key, "edited")
    assert edited["edited_at"] is not None
    # 수정 뒤 replay: 본문 비교 생략 → 200 원 메시지의 현재(수정된) 상태.
    st, body = await _post(server, _payload(key, "a"))
    again = json.loads(body)["message"]
    assert st == 200 and (again["id"], again["body"]) == (mid, "edited") and again["edited_at"] is not None
    st, body = await _history(server)
    page = json.loads(body)["messages"]
    assert [(m["id"], m["client_message_id"], m["body"]) for m in page] == [(mid, key, "edited")]
    assert (await _patch(server, str(uuid.uuid4()), "x"))[0] == 404


async def test_fake_mentions_filter_self_nonmember_inactive(server):
    stranger = str(uuid.UUID(int=999))
    _st, b1 = await _post(server, _payload(str(uuid.uuid4()), mention_user_ids=[BOT_ID, OWNER_ID, stranger]))
    assert json.loads(b1)["message"]["mention_user_ids"] == [OWNER_ID]
    server.inactive_user_ids.add(OTHER_ID)
    _st, b2 = await _post(server, _payload(str(uuid.uuid4()), mention_user_ids=[OTHER_ID, OWNER_ID]), cid=CHANNEL_ID)
    assert json.loads(b2)["message"]["mention_user_ids"] == [OWNER_ID]
    # 빈 멘션 저장 뒤: 자기 자신·비참여자만 더한 재요청은 replay, 생성 시점 활성 참여자를 더하면 409.
    key = str(uuid.uuid4())
    assert (await _post(server, _payload(key)))[0] == 201
    for same in ([BOT_ID], [stranger], [BOT_ID, stranger]):
        assert (await _post(server, _payload(key, mention_user_ids=same)))[0] == 200, same
    assert (await _post(server, _payload(key, mention_user_ids=[OWNER_ID])))[0] == 409


async def test_fake_mentions_replay_uses_current_membership_and_join_time(server):
    # S/messages/repo.ts:150-161 sameMentions: 요청에만 있는 ID 중 "재요청 당시 left_at IS NULL·status='active'
    # 이고 joined_at <= 메시지 createdAt"인 사람이 있으면 충돌(409), 없으면 같은 요청(replay 200).
    server.clock = lambda: 1000.0
    # (가) 멘션 없이 생성 → 그 사람 퇴장(left_at 설정) → 그 사람만 넣은 재요청: 현재 자격 없음 → replay 200.
    key = str(uuid.uuid4())
    assert (await _post(server, _payload(key), cid=CHANNEL_ID))[0] == 201
    server.leave(CHANNEL_ID, OTHER_ID)
    assert (await _post(server, _payload(key, mention_user_ids=[OTHER_ID]), cid=CHANNEL_ID))[0] == 200
    # (나) 반대 전환 1: 생성 뒤(joined_at 2000 > createdAt 1000) 가입한 사람을 넣은 재요청 → 생성 이전 가입 조건
    # (cm.joined_at <= $4) 불충족 → 자격 없음 → 200.
    key2, late = str(uuid.uuid4()), str(uuid.UUID(int=555))
    assert (await _post(server, _payload(key2), cid=CHANNEL_ID))[0] == 201
    server.join(CHANNEL_ID, late, at=2000.0)
    assert (await _post(server, _payload(key2, mention_user_ids=[late]), cid=CHANNEL_ID))[0] == 200
    # (나) 반대 전환 2: 생성 때 비활성(저장 멘션에서 빠짐)이었다가 지금 활성인 기존 참여자 → 재요청 당시 자격 → 409.
    server.members[CHANNEL_ID].add(OTHER_ID)
    server.inactive_user_ids.add(OTHER_ID)
    key3 = str(uuid.uuid4())
    assert (await _post(server, _payload(key3, mention_user_ids=[OTHER_ID]), cid=CHANNEL_ID))[0] == 201
    server.inactive_user_ids.discard(OTHER_ID)
    assert (await _post(server, _payload(key3, mention_user_ids=[OTHER_ID]), cid=CHANNEL_ID))[0] == 409


async def test_fake_root_uuid_is_case_insensitive(server):
    # S/bots/routes.ts:201-203(소문자 정규화 가시성)·S/messages/repo.ts:183-190(DB uuid 비교): 대문자 지정도 정상.
    root = _seed_root(server)
    assert root == root.lower()
    key = str(uuid.uuid4())
    assert (await _post(server, _payload(key, thread_root_id=root.upper())))[0] == 201
    assert (await _post(server, _payload(key, thread_root_id=root)))[0] == 200  # 같은 키·소문자 = 같은 payload
    assert (await _post(server, _payload(str(uuid.uuid4()), thread_root_id=root.upper())))[0] == 201


async def test_fake_attachment_must_be_own_fresh_upload_in_same_conversation(server):
    other_conv = await _upload(server, CHANNEL_ID)
    other_uploader = server.seed_attachment(conv=DM_ID, uploader=OWNER_ID)
    expired = server.seed_attachment(conv=DM_ID, age=server.attachment_ttl_s + 1)
    deleted = server.seed_attachment(conv=DM_ID, deleted=True)
    fresh = await _upload(server)
    for bad in ([str(uuid.uuid4())], [other_conv], [other_uploader], [expired], [deleted], [fresh, fresh]):
        key = str(uuid.uuid4())
        st, body = await _post(server, _payload(key, attachment_ids=bad))
        assert (st, json.loads(body)) == (400, INVALID_ATTACHMENTS), bad
        assert _stored(server, key) == [] and server.current_bound(fresh) is None  # 롤백: 메시지 0개·결속 0
        # 롤백이라 같은 키는 아직 비어 있다 → 올바른 게시가 처음 저장(201).
        assert (await _post(server, _payload(key)))[0] == 201
    assert (await _post(server, _payload(str(uuid.uuid4()), attachment_ids=[fresh.upper()])))[0] == 201


async def test_fake_replay_skips_body_check_after_delete(server):
    key = str(uuid.uuid4())
    _st, b1 = await _post(server, _payload(key, "a"))
    server.tombstone(json.loads(b1)["message"]["id"])
    st, body = await _post(server, _payload(key, "different"))
    assert st == 200 and json.loads(body)["message"]["deleted_at"] is not None


async def test_fake_rebinding_attachment_is_400(server):
    aid = await _upload(server)  # 가짜 업로드가 반환한 ID로 시작
    assert (await _post(server, _payload(str(uuid.uuid4()), attachment_ids=[aid])))[0] == 201
    st, body = await _post(server, _payload(str(uuid.uuid4()), attachment_ids=[aid]))
    assert (st, json.loads(body)) == (400, INVALID_ATTACHMENTS)


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
    # 완전한 HTTP 응답에 잘린/깨진 JSON(본문 파싱 실패) — 수신 자체는 성공.
    server.post_body_fault_after_commit = ["json_truncated", "json_invalid"]
    for _ in range(2):
        st, raw = await _post(server, _payload(key))
        assert st == 200
        with pytest.raises(ValueError):
            json.loads(raw)
    # 선언 길이(Content-Length)보다 적게 보내고 연결 닫기 — 수신 단계의 ClientPayloadError(파싱 전).
    server.post_body_fault_after_commit = ["short_body"]
    with pytest.raises(aiohttp.ClientPayloadError):
        await _post(server, _payload(key))
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
    server.history_body_fault = ["json_invalid"]
    st, raw = await _history(server)
    assert st == 200
    with pytest.raises(ValueError):
        json.loads(raw)
    server.history_delay = 0.05
    assert (await _history(server))[0] == 200
    assert server.history_calls == 6
