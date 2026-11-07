import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import { createMessageEvents, type MessageChange, type MessageDeleted } from '../../src/modules/messages/events.js';
import { createMessagesService } from '../../src/modules/messages/service.js';
import type { MessageRecord, MessagesStore, NewMessage, Page, SendResult, WriteResult } from '../../src/modules/messages/store.js';

/** 서비스 분기와 이벤트 발행 시점(성공 후에만)만 본다. 저장소는 고정 결과를 돌려주는 가짜다. */
const NOW = 1_700_000_000_000;
const DELETED_AT = new Date(NOW - 5);

function record(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 3,
    authorId: 'u1',
    clientMessageId: 'k1',
    threadRootId: null,
    body: 'hi',
    createdAt: new Date(NOW),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
    ...over,
  };
}

interface Fake {
  sendResult: SendResult;
  writeResult: WriteResult;
  got?: MessageRecord;
  located?: { conversationId: string; authorId: string; threadRootId: string | null };
  readonly sent: NewMessage[];
  readonly calls: string[];
}

function setup() {
  const page: Page = { messages: [record()], hasMore: false };
  const fake: Fake = {
    sendResult: { kind: 'created', message: record(), changeId: 7 },
    writeResult: { kind: 'ok', message: record(), changeId: 8 },
    got: record(),
    located: { conversationId: 'c1', authorId: 'u1', threadRootId: null },
    sent: [],
    calls: [],
  };
  const store: MessagesStore = {
    async locate() {
      return fake.located;
    },
    async send(m) {
      fake.sent.push(m);
      return fake.sendResult;
    },
    async edit(e) {
      fake.calls.push(`edit:${e.id}:${e.editorId}:${e.body}:${e.at.getTime()}`);
      return fake.writeResult;
    },
    async remove(id, actor, at) {
      fake.calls.push(`remove:${id}:${actor}:${at.getTime()}`);
      return fake.writeResult;
    },
    async history(c, p) {
      fake.calls.push(`history:${c}:${p.limit}`);
      return page;
    },
    async get() {
      return fake.got;
    },
    async replies(r, p) {
      fake.calls.push(`replies:${r}:${p.limit}`);
      return page;
    },
  };
  const access: string[] = [];
  const conversations = {
    async assertAccess(userId: string, conversationId: string, action: string) {
      access.push(`${userId}:${conversationId}:${action}`);
      if (userId === 'outsider') throw new HttpError(404, 'not_found');
      return { kind: 'channel', activeMember: true };
    },
  } as unknown as ConversationsService;
  const events = createMessageEvents();
  const seen = { created: [] as MessageChange[], updated: [] as MessageChange[], deleted: [] as MessageDeleted[] };
  events.on('created', (e) => seen.created.push(e));
  events.on('updated', (e) => seen.updated.push(e));
  events.on('deleted', (e) => seen.deleted.push(e));
  const service = createMessagesService({ store, conversations, events, clock: () => NOW });
  return { service, fake, access, seen, page };
}

const input = { clientMessageId: 'k1', body: 'hi', threadRootId: null, mentionUserIds: ['u2'] };

async function status(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (error) {
    if (error instanceof HttpError) return [error.statusCode, error.code];
    throw error;
  }
  return [0, 'resolved'];
}

describe('messages 서비스: send', () => {
  it('created → created 이벤트 1건, created:true, 저장소에 새 id·clock 시각 전달', async () => {
    const { service, fake, seen } = setup();
    const out = await service.send('u1', 'c1', input);
    expect(out).toEqual({ message: record(), changeId: 7, created: true });
    expect(seen.created).toEqual([{ changeId: 7, message: record() }]);
    const sent = fake.sent[0];
    expect(sent).toMatchObject({ conversationId: 'c1', authorId: 'u1', ...input });
    expect(sent?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.at.getTime()).toBe(NOW);
  });

  it('replayed → 이벤트 없음, created:false', async () => {
    const { service, fake, seen } = setup();
    fake.sendResult = { kind: 'replayed', message: record(), changeId: 7 };
    expect(await service.send('u1', 'c1', input)).toEqual({ message: record(), changeId: 7, created: false });
    expect(seen.created).toHaveLength(0);
  });

  it('conflict 409·bad_root 400·not_member 404, 모두 이벤트 없음', async () => {
    const { service, fake, seen } = setup();
    const cases: [SendResult['kind'], [number, string]][] = [
      ['conflict', [409, 'idempotency_conflict']],
      ['bad_root', [400, 'invalid_thread_root']],
      ['not_member', [404, 'not_found']],
    ];
    for (const [kind, expected] of cases) {
      fake.sendResult = { kind } as SendResult;
      expect(await status(service.send('u1', 'c1', input))).toEqual(expected);
    }
    expect(seen.created).toHaveLength(0);
  });
});

describe('messages 서비스: edit·remove', () => {
  it('edit ok → updated 이벤트, forbidden 403·not_found 404는 이벤트 없음', async () => {
    const { service, fake, seen } = setup();
    expect(await service.edit('u1', 'm1', 'new', ['u2'])).toMatchObject({ message: record(), changeId: 8, created: false });
    expect(fake.calls).toEqual([`edit:m1:u1:new:${NOW}`]);
    expect(seen.updated).toHaveLength(1);
    expect(seen.updated[0]).toMatchObject({ message: record(), changeId: 8 });
    fake.writeResult = { kind: 'forbidden' };
    expect(await status(service.edit('u2', 'm1', 'x', []))).toEqual([403, 'forbidden']);
    fake.writeResult = { kind: 'not_found' };
    expect(await status(service.edit('u1', 'm1', 'x', []))).toEqual([404, 'not_found']);
    expect(seen.updated).toHaveLength(1);
  });

  it('remove ok → deleted 이벤트(본문 없음), deletedAt 없으면 clock 시각', async () => {
    const { service, fake, seen } = setup();
    fake.writeResult = { kind: 'ok', message: record({ body: null, deletedAt: DELETED_AT }), changeId: 9 };
    const out = await service.remove('u1', 'm1');
    expect(out.created).toBe(false);
    expect(fake.calls).toEqual([`remove:m1:u1:${NOW}`]);
    expect(seen.deleted).toEqual([{ changeId: 9, conversationId: 'c1', messageId: 'm1', seq: 3, deletedAt: DELETED_AT }]);
    fake.writeResult = { kind: 'ok', message: record(), changeId: 10 };
    await service.remove('u1', 'm1');
    expect(seen.deleted[1]?.deletedAt.getTime()).toBe(NOW);
  });

  it('remove forbidden 403·not_found 404 → 이벤트 없음', async () => {
    const { service, fake, seen } = setup();
    fake.writeResult = { kind: 'forbidden' };
    expect(await status(service.remove('u2', 'm1'))).toEqual([403, 'forbidden']);
    fake.writeResult = { kind: 'not_found' };
    expect(await status(service.remove('u1', 'm1'))).toEqual([404, 'not_found']);
    expect(seen.deleted).toHaveLength(0);
  });
});

describe('messages 서비스: 접근·조회', () => {
  it('resolveAccess: 메시지 → 대화로 assertAccess 위임, 없는 메시지 404, 비참여자 404', async () => {
    const { service, fake, access } = setup();
    expect(await service.resolveAccess('u1', 'm1', 'write')).toEqual(fake.located);
    expect(access).toEqual(['u1:c1:write']);
    expect(await status(service.resolveAccess('outsider', 'm1', 'read'))).toEqual([404, 'not_found']);
    fake.located = undefined;
    expect(await status(service.resolveAccess('u1', 'm1', 'read'))).toEqual([404, 'not_found']);
    expect(access).toHaveLength(2);
  });

  it('history는 저장소 위임, replies: 원문 없음 404, 답글 원문 400, 정상은 root+page', async () => {
    const { service, fake, page } = setup();
    expect(await service.history('c1', { limit: 5 })).toBe(page);
    expect(await service.replies('m1', { limit: 4 })).toEqual({ root: record(), page });
    expect(fake.calls).toEqual(['history:c1:5', 'replies:m1:4']);
    fake.got = record({ threadRootId: 'r0' });
    expect(await status(service.replies('m1', { limit: 4 }))).toEqual([400, 'invalid_thread_root']);
    fake.got = undefined;
    expect(await status(service.replies('m1', { limit: 4 }))).toEqual([404, 'not_found']);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('message 이벤트 버스', () => {
  it('on은 해제 함수를 돌려주고, 해제 후에는 호출되지 않는다', () => {
    const events = createMessageEvents();
    const seen: number[] = [];
    const off = events.on('updated', (e) => seen.push(e.changeId));
    events.updated({ changeId: 1, message: record() });
    off();
    events.updated({ changeId: 2, message: record() });
    events.created({ changeId: 3, message: record() });
    expect(seen).toEqual([1]);
  });
});
