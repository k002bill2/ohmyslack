import { randomUUID } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import { describe, expect, it } from 'vitest';
import { buildBotApp } from '../../src/modules/bots/listener.js';
import type { BotService } from '../../src/modules/bots/service.js';
import { botOutMetric } from '../../src/modules/bots/ws.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import type { MessageChange } from '../../src/modules/messages/events.js';
import type { MessagesService, WriteOutcome } from '../../src/modules/messages/service.js';
import type { MessageRecord } from '../../src/modules/messages/store.js';
import { createMetricsRecorder, type MetricDims, type MetricsRecorder, type MetricsStore } from '../../src/modules/ops/metrics.js';
import { createPushService, parsePushConfig, type PushSend, type PushStore } from '../../src/modules/push/index.js';
import { HttpError } from '../../src/http/errors.js';
import type { SyncService } from '../../src/modules/sync/service.js';

/** PRD §10 서버 관찰 이벤트 배선: push_send_result·bot_delivery_result(in/out). 기록기는 실제 검증·버킷팅 + 메모리 저장소. */
interface Stored {
  readonly event: string;
  readonly dims: MetricDims;
}

function capture(clock: () => number = () => 0): { readonly metrics: MetricsRecorder & { idle(): Promise<void> }; readonly rows: Stored[] } {
  const rows: Stored[] = [];
  const store: MetricsStore = {
    async increment(_day, event, dims) {
      rows.push({ event, dims });
    },
    pruneBefore: async () => 0,
  };
  return { metrics: createMetricsRecorder({ store, clock }), rows };
}

const throwing: MetricsRecorder = {
  record() {
    throw new Error('metrics down');
  },
};

function message(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    seq: 1,
    authorId: randomUUID(),
    authorKind: 'bot',
    clientMessageId: randomUUID(),
    threadRootId: null,
    body: 'hello',
    createdAt: new Date(1000),
    editedAt: null,
    deletedAt: null,
    mentionUserIds: [],
    rootReplyCount: 0,
    ...over,
  };
}

describe('push_send_result 배선(push/service deliver)', () => {
  const keys = generateVAPIDKeys();
  const config = parsePushConfig(JSON.stringify({ public_key: keys.publicKey, private_key: keys.privateKey }), 'mailto:ops@example.test');

  async function run(send: PushSend, metrics: MetricsRecorder) {
    if (config === undefined) throw new Error('VAPID 설정 생성 실패');
    const target = { id: randomUUID(), userId: randomUUID(), endpoint: 'https://web.push.apple.com/OMS-CANARY-PUSHEP-2a9c71', p256dh: 'p', auth: 'a' };
    const store = {
      context: () => Promise.resolve({ botDm: false, channel: true, rootAuthorId: null }),
      targets: () => Promise.resolve([target]),
      isLive: () => Promise.resolve(true),
      markSuccess: () => Promise.resolve(),
      deleteById: () => Promise.resolve(),
    } as unknown as PushStore;
    const service = createPushService({ store, logger: { log: () => undefined }, clock: () => 0, config, send, schedule: (task) => task(), metrics });
    service.onMessageCreated({ changeId: 1, message: message() } as MessageChange);
    await service.idle();
  }

  it('2xx sent, 404·410 expired, 그 밖·예외 failed — outcome만 기록한다(endpoint 없음)', async () => {
    const { metrics, rows } = capture();
    await run(async () => 201, metrics);
    await run(async () => 410, metrics);
    await run(async () => 500, metrics);
    await run(async () => {
      throw new Error('network');
    }, metrics);
    await metrics.idle();
    expect(rows).toEqual([
      { event: 'push_send_result', dims: { outcome: 'sent' } },
      { event: 'push_send_result', dims: { outcome: 'expired' } },
      { event: 'push_send_result', dims: { outcome: 'failed' } },
      { event: 'push_send_result', dims: { outcome: 'failed' } },
    ]);
    expect(JSON.stringify(rows)).not.toContain('OMS-CANARY');
  });
});

describe('bot_delivery_result 배선', () => {
  const BOT = '00000000-0000-4000-8000-000000000001';
  const CONV = '00000000-0000-4000-8000-0000000000aa';
  const auth = { authorization: `Bearer omsb_${'A'.repeat(43)}`, host: '127.0.0.1:4100', 'content-type': 'application/json' };

  function botApp(send: MessagesService['send'], metrics: MetricsRecorder | undefined, clock: () => number) {
    const bots = { verifyToken: async () => ({ botUserId: BOT, tokenId: 't' }), visibleMessageIds: async (_u: string, ids: readonly string[]) => new Set(ids) } as unknown as BotService;
    const conversations = { assertAccess: async () => ({ kind: 'dm', activeMember: true }) } as unknown as ConversationsService;
    return buildBotApp({
      bots,
      conversations,
      messages: { send } as unknown as MessagesService,
      sync: {} as SyncService,
      logger: { log: () => undefined },
      port: 4100,
      clock,
      ...(metrics === undefined ? {} : { metrics }),
    });
  }

  const outcomes = (created: boolean): MessagesService['send'] => async (): Promise<WriteOutcome> => ({ message: message(), changeId: 1, created });
  const post = (app: ReturnType<typeof botApp>, payload: object) =>
    app.inject({ method: 'POST', url: `/api/bot/v1/conversations/${CONV}/messages`, headers: auth, payload });
  const body = { client_message_id: '00000000-0000-4000-8000-0000000000c1', body: 'OMS-CANARY-BODY-6f1c2a' };

  it('in: 201 ok·200 duplicate·4xx rejected·5xx failed, has_attachment·처리시간 버킷, 본문·ID 없음', async () => {
    let now = 0;
    const clock = () => now;
    const { metrics, rows } = capture();
    const tick = (ms: number, inner: MessagesService['send']): MessagesService['send'] => async (...args) => {
      now += ms;
      return inner(...args);
    };
    const cases: [MessagesService['send'], object][] = [
      [tick(120, outcomes(true)), body],
      [tick(3, outcomes(false)), { ...body, attachment_ids: ['00000000-0000-4000-8000-0000000000d1'] }],
      [async () => {
        throw new HttpError(409, 'idempotency_conflict');
      }, body],
      [async () => {
        throw new Error('db down');
      }, body],
    ];
    for (const [send, payload] of cases) {
      const app = botApp(send, metrics, clock);
      await post(app, payload);
      await app.close();
    }
    const app = botApp(outcomes(true), metrics, clock);
    expect((await post(app, { body: 'no key' })).statusCode).toBe(400);
    await app.close();
    await metrics.idle();
    const dims = rows.map((r) => (r.event === 'bot_delivery_result' ? r.dims : r.event));
    expect(dims).toEqual([
      { direction: 'in', outcome: 'ok', has_attachment: false, duration_ms: 100 },
      { direction: 'in', outcome: 'duplicate', has_attachment: true, duration_ms: 0 },
      { direction: 'in', outcome: 'rejected', has_attachment: false, duration_ms: 0 },
      { direction: 'in', outcome: 'failed', has_attachment: false, duration_ms: 0 },
      { direction: 'in', outcome: 'rejected', has_attachment: false, duration_ms: 0 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('OMS-CANARY');
    expect(JSON.stringify(rows)).not.toContain(CONV);
  });

  it('계측 기록기가 throw해도 봇 전송 응답(상태·본문)은 계측 없을 때와 같다', async () => {
    const fixed = message({ id: '00000000-0000-4000-8000-0000000000e1' });
    const send: MessagesService['send'] = async () => ({ message: fixed, changeId: 7, created: true });
    const responses = [];
    for (const metrics of [undefined, throwing]) {
      const app = botApp(send, metrics, () => 0);
      const res = await post(app, body);
      responses.push({ status: res.statusCode, body: res.json() });
      await app.close();
    }
    expect(responses[1]).toEqual(responses[0]);
    expect(responses[0]?.status).toBe(201);
  });

  it('out: botOutMetric는 전달 결과·첨부 유무·생성→전달 지연 버킷만 담는다', async () => {
    const { metrics, rows } = capture();
    const m = message({ createdAt: new Date(1000) });
    metrics.record(botOutMetric(m, true, 1000 + 730));
    metrics.record(botOutMetric({ ...m, attachments: [{} as NonNullable<MessageRecord['attachments']>[number]] }, false, 1000 + 12));
    await metrics.idle();
    expect(rows).toEqual([
      { event: 'bot_delivery_result', dims: { direction: 'out', outcome: 'ok', has_attachment: false, duration_ms: 500 } },
      { event: 'bot_delivery_result', dims: { direction: 'out', outcome: 'failed', has_attachment: true, duration_ms: 0 } },
    ]);
  });
});
