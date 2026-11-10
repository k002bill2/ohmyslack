import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { png, uploadedId } from '../attachments/att-harness.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { bot as botCall, botUpload, count, setupBotListener, teardownBotListener, type BotListenerContext } from './bot-listener-harness.js';

/** PR #12 보안 리뷰 P3(F-1·F-2·F-4·F-5) 회귀(정본: BOT_CHANNEL_SPEC §4-5, THREAT_MODEL TM-BOT-04). */
let lc: BotListenerContext;

beforeEach(async () => {
  lc = await setupBotListener();
});

afterEach(async () => {
  await teardownBotListener(lc);
});

type Session = Awaited<ReturnType<typeof as>>;

async function post(owner: Session, channel: string, body: string, extra: Record<string, unknown> = {}): Promise<{ id: string; seq: number }> {
  const res = await req(lc.conv.app, 'POST', `/api/conversations/${channel}/messages`, owner, { client_message_id: randomUUID(), body, ...extra });
  expect(res.statusCode, body).toBe(201);
  const m = res.json<{ message: { id: string; seq: number } }>().message;
  return { id: m.id, seq: m.seq };
}

async function addBot(owner: Session, channel: string, botUserId = lc.bot.botUserId): Promise<void> {
  expect((await req(lc.conv.app, 'POST', `/api/conversations/${channel}/bots`, owner, { bot_user_id: botUserId })).statusCode).toBe(201);
}

const ids = (items: readonly { id: string }[]): string[] => items.map((m) => m.id);

/** 응답 본문에서 요청마다 다른 request_id만 뺀 나머지(존재 은폐 비교용). */
function stable(json: unknown): unknown {
  const error = (json as { error?: Record<string, unknown> } | undefined)?.error;
  if (error === undefined) return json;
  return { ...(json as object), error: Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'request_id')) };
}

describe('봇 가시성 가드 통일(F-1·F-5)', () => {
  it('FR-BOT-09 F-1 F-5 봇 제거 후 재추가하면 첫 참여 기간 루트에 대한 PATCH(자기 글)·read-state(thread_root_id)·답글 쓰기가 모두 404이고 본문이 없는 ID·비참여 다른 대화와 같으며 저장 0', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const channel = await createChannel(app, owner, 'readd-room');
    const other = await createChannel(app, owner, 'other-room');
    const otherRoot = await post(owner, other, '봇 비참여 대화 루트');

    // 첫 참여 기간: 봇이 루트를 쓰고 사람이 답글을 단다.
    await addBot(owner, channel);
    const first = await botCall(lc, 'POST', `conversations/${channel}/messages`, { client_message_id: randomUUID(), body: '봇 첫 루트' });
    expect(first.status).toBe(201);
    const oldRoot = first.json.message as { id: string; seq: number };
    const oldReply = await post(owner, channel, '첫 기간 답글', { thread_root_id: oldRoot.id });

    // 제거 → 재추가: joined_seq가 올라가 옛 루트가 숨김이 된다.
    expect((await req(app, 'DELETE', `/api/conversations/${channel}/bots/${lc.bot.botUserId}`, owner)).statusCode).toBe(204);
    await addBot(owner, channel);
    const lateReply = await post(owner, channel, '재추가 뒤 옛 스레드 답글', { thread_root_id: oldRoot.id });

    const patch = (id: string) => botCall(lc, 'PATCH', `messages/${id}`, { body: '수정 시도' });
    const readState = (root: string, seq: number) => botCall(lc, 'PUT', 'read-state', { conversation_id: channel, thread_root_id: root, last_read_seq: seq });
    const reply = (root: string) => botCall(lc, 'POST', `conversations/${channel}/messages`, { client_message_id: randomUUID(), body: '봇 답글', thread_root_id: root });

    const missing = randomUUID();
    const threadReads = (): Promise<number> => count(lc, 'SELECT count(*)::int AS n FROM thread_read_state WHERE user_id = $1', [lc.bot.botUserId]);
    const messageCount = (): Promise<number> => count(lc, 'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [channel]);
    const readsBefore = await threadReads();
    const messagesBefore = await messageCount();
    const bodyBefore = await count(lc, "SELECT count(*)::int AS n FROM messages WHERE id = $1 AND body = '봇 첫 루트'", [oldRoot.id]);
    expect(bodyBefore).toBe(1);

    const cases = {
      patch: [await patch(oldRoot.id), await patch(oldRoot.id.toUpperCase()), await patch(missing), await patch(otherRoot.id)],
      // 이전 오라클: last_read_seq ≤ 최대 답글 seq면 200, 초과면 400. 이제 seq와 무관하게 404.
      readState: [
        await readState(oldRoot.id, oldReply.seq),
        await readState(oldRoot.id, lateReply.seq),
        await readState(oldRoot.id, lateReply.seq + 100),
        await readState(missing, 1),
        await readState(otherRoot.id, otherRoot.seq),
      ],
      reply: [await reply(oldRoot.id), await reply(missing), await reply(otherRoot.id)],
    };
    const expected = stable(cases.patch[2]?.json);
    for (const [route, results] of Object.entries(cases)) {
      for (const r of results) {
        expect(r.status, route).toBe(404);
        expect(stable(r.json), route).toEqual(expected);
      }
    }
    expect(expected).toEqual({ error: expect.objectContaining({ code: 'not_found' }) });

    // 저장 0: 읽음 행·메시지 수·옛 루트 본문 그대로.
    expect(await threadReads()).toBe(readsBefore);
    expect(await messageCount()).toBe(messagesBefore);
    expect(await count(lc, "SELECT count(*)::int AS n FROM messages WHERE id = $1 AND body = '봇 첫 루트' AND edited_at IS NULL", [oldRoot.id])).toBe(1);

    // 보이는 대상은 그대로 동작한다: 재추가 뒤 자기 루트 수정 200, 그 스레드 read-state 200.
    const fresh = await botCall(lc, 'POST', `conversations/${channel}/messages`, { client_message_id: randomUUID(), body: '봇 새 루트' });
    expect(fresh.status).toBe(201);
    const freshReply = await post(owner, channel, '새 루트 답글', { thread_root_id: fresh.json.message.id });
    expect((await patch(fresh.json.message.id)).status).toBe(200);
    expect((await readState(fresh.json.message.id, freshReply.seq)).status).toBe(200);
    expect((await botCall(lc, 'PUT', 'read-state', { conversation_id: channel, last_read_seq: fresh.json.message.seq })).status).toBe(200);

    // 사람 경로 변화 0: owner는 옛 스레드 read-state·수정이 된다.
    expect((await req(app, 'PUT', '/api/read-state', owner, { conversation_id: channel, thread_root_id: oldRoot.id, last_read_seq: lateReply.seq })).statusCode).toBe(200);
  });
});

describe('봇 페이지 joined_seq 자르기(F-2·F-4)', () => {
  it('FR-BOT-09 F-2 숨김 구간 snapshot 페이징은 빈 페이지 없이 has_more=false·next_before_seq=null로 끝난다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const channel = await createChannel(app, owner, 'snap-room');
    const hidden = [await post(owner, channel, '참여 전 1'), await post(owner, channel, '참여 전 2'), await post(owner, channel, '참여 전 3')];
    await addBot(owner, channel);
    const a = await post(owner, channel, '참여 후 A');
    const b = await post(owner, channel, '참여 후 B');

    const pages: { messages: { id: string }[]; has_more: boolean; next_before_seq: number | null }[] = [];
    let before: number | null = null;
    for (let i = 0; i < 10; i += 1) {
      const q: string = before === null ? '' : `&before_seq=${before}`;
      const res = await botCall(lc, 'GET', `sync/snapshot?conversation_id=${channel}&limit=1${q}`);
      expect(res.status).toBe(200);
      pages.push(res.json);
      if (!res.json.has_more) break;
      before = res.json.next_before_seq;
    }
    expect(pages.map((p) => ids(p.messages))).toEqual([[b.id], [a.id]]);
    expect(pages.at(-1)).toMatchObject({ has_more: false, next_before_seq: null });
    expect(JSON.stringify(pages).includes('참여 전')).toBe(false);

    // 숨김 구간을 직접 가리켜도 빈 마지막 페이지(seq 노출 없음).
    const direct = await botCall(lc, 'GET', `sync/snapshot?conversation_id=${channel}&limit=1&before_seq=${a.seq}`);
    expect(direct.json).toMatchObject({ messages: [], has_more: false, next_before_seq: null });
    expect(hidden.length).toBe(3);
  });

  it('FR-BOT-09 F-4 이력 after_seq를 joined_seq보다 작게+limit 1로 주면 한 번에 보이는 첫 메시지가 온다', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const channel = await createChannel(app, owner, 'hist-room');
    for (let i = 0; i < 4; i += 1) await post(owner, channel, `참여 전 ${i}`);
    await addBot(owner, channel);
    const a = await post(owner, channel, '참여 후 A');
    const b = await post(owner, channel, '참여 후 B');

    const firstPage = await botCall(lc, 'GET', `conversations/${channel}/messages?after_seq=0&limit=1`);
    expect(firstPage.status).toBe(200);
    expect(ids(firstPage.json.messages)).toEqual([a.id]);
    expect(firstPage.json.has_more).toBe(true);
    const next = await botCall(lc, 'GET', `conversations/${channel}/messages?after_seq=${a.seq}&limit=1`);
    expect(ids(next.json.messages)).toEqual([b.id]);
    // 형식 오류는 기존과 같은 400.
    expect((await botCall(lc, 'GET', `conversations/${channel}/messages?after_seq=-1`)).status).toBe(400);
  });
});

describe('봇 첨부 미결합 규칙(§4-5 ⑦)', () => {
  it('FR-BOT-09 미결합 첨부는 업로더 본인만 받는다 — 다른 봇·사람이 올린 미결합 첨부는 404', async () => {
    const app = lc.conv.app;
    const owner = await as(app, 'a');
    const channel = await createChannel(app, owner, 'att-room');
    const other = await lc.service.createBot({ displayName: 'Other Bot', slug: 'other-bot' });
    const otherToken = (await lc.service.issueToken(other.botUserId, 'adapter')).token;
    await addBot(owner, channel);
    await addBot(owner, channel, other.botUserId);

    const humanFile = await uploadedId(app, owner, channel, png(), 'image/png');
    const mine = await botUpload(lc, channel, png(), 'image/png');
    const theirs = await botUpload(lc, channel, png(), 'image/png', otherToken);
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const mineId = mine.json.attachment_id as string;
    const theirsId = theirs.json.attachment_id as string;

    expect((await botCall(lc, 'GET', `attachments/${mineId}`)).status).toBe(200);
    const denied = [await botCall(lc, 'GET', `attachments/${theirsId}`), await botCall(lc, 'GET', `attachments/${humanFile}`), await botCall(lc, 'GET', `attachments/${randomUUID()}`)];
    for (const r of denied) {
      expect(r.status).toBe(404);
      expect(stable(r.json)).toEqual(stable(denied[2]?.json));
    }
    // 다른 봇은 자기 것만.
    expect((await botCall(lc, 'GET', `attachments/${theirsId}`, undefined, otherToken)).status).toBe(200);
    expect((await botCall(lc, 'GET', `attachments/${mineId}`, undefined, otherToken)).status).toBe(404);
  });
});
