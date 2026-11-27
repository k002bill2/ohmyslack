import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotService } from '../../src/modules/bots/service.js';
import { registerBotRealtime } from '../../src/modules/bots/ws.js';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import { createConversationsService } from '../../src/modules/conversations/service.js';
import type { ConversationsStore } from '../../src/modules/conversations/store.js';
import { createMessageEvents } from '../../src/modules/messages/events.js';
import type { MessageRecord } from '../../src/modules/messages/store.js';
import { createMetricsRecorder, type MetricDims } from '../../src/modules/ops/metrics.js';
import { createReadEvents } from '../../src/modules/sync/events.js';
import type { SyncStore } from '../../src/modules/sync/store.js';
import type { WsClient } from '../realtime/ws-int-harness.js';
import { connectedBot, subscribeBot } from './bot-ws-harness.js';

/**
 * QA P2-1: 봇 수신(in) 계측의 실경로 — registerBotRealtime 배선(onMessageDelivered) → 허브 전달 → 기록기.
 * botReceiveMetric 단독 호출이 아니라, 실제 봇 WS 연결·구독 후 message.created 전달이 bot_delivery_result{in}을 남기는지 본다.
 */
const BOT = '00000000-0000-4000-8000-000000000001';
const CONV = '00000000-0000-4000-8000-0000000000aa';
const T0 = Date.UTC(2026, 10, 28, 9);
const WATERMARK = 10;

let app: FastifyInstance | undefined;
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await app?.close();
  app = undefined;
});

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function message(): MessageRecord {
  return {
    id: randomUUID(),
    conversationId: CONV,
    seq: 1,
    authorId: randomUUID(),
    authorKind: 'human',
    clientMessageId: randomUUID(),
    threadRootId: null,
    body: 'OMS-CANARY-BODY-6f1c2a',
    createdAt: new Date(T0),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
  };
}

describe('봇 수신(in) 계측 실경로(registerBotRealtime)', () => {
  it('봇 연결·구독 후 message.created 전달 → bot_delivery_result{direction:in, outcome:ok} 1건, 본문·ID 없음', async () => {
    const rows: { event: string; dims: MetricDims; n: number }[] = [];
    const metrics = createMetricsRecorder({
      store: {
        async add(_day, event, dims, n) {
          rows.push({ event, dims, n });
        },
        pruneBefore: async () => 0,
      },
      clock: () => T0,
    });
    const bots = {
      verifyToken: async () => ({ botUserId: BOT, tokenId: 't1' }),
      liveTokenIds: async (ids: readonly string[]) => new Set(ids),
      visibleMessageIds: async (_u: string, ids: readonly string[]) => new Set(ids),
    } as unknown as BotService;
    const conversationStore = {
      findAccess: async () => ({ kind: 'channel', activeMember: true }),
    } as unknown as ConversationsStore;
    const syncStore: SyncStore = {
      watermark: async () => WATERMARK,
      retentionFloor: async () => 0,
      scan: async (r) => ({ scannedThrough: r.through, changes: [] }),
      snapshot: unused,
      mergeRead: unused,
    };
    const conversationEvents = createConversationEvents();
    const messageEvents = createMessageEvents();
    // 생성→전달 지연 500ms 구간이 되게 전달 시각을 고정한다.
    const clock = () => T0 + 730;
    app = Fastify({ logger: false });
    registerBotRealtime(app, {
      bots,
      conversations: createConversationsService({ store: conversationStore, events: conversationEvents, clock }),
      clock,
      realtime: { syncStore, conversationEvents, messageEvents, readEvents: createReadEvents() },
      metrics,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const bot = await connectedBot(port, `omsb_${'A'.repeat(43)}`);
    clients.push(bot);
    expect((await subscribeBot(bot, CONV, WATERMARK)).type).toBe('conversation.subscribed');
    const m = message();
    messageEvents.created({ changeId: WATERMARK + 1, message: m });
    await bot.waitFor((f) => f.type === 'message.created');
    await metrics.idle();

    expect(rows).toEqual([
      { event: 'bot_delivery_result', dims: { direction: 'in', outcome: 'ok', has_attachment: false, duration_ms: 500 }, n: 1 },
    ]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('OMS-CANARY');
    expect(dump).not.toContain(m.id);
    expect(dump).not.toContain(CONV);
  });
});
