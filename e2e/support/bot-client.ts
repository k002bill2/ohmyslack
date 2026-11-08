import { buildBotApp, createBotEvents, createBotService, listenBot, type CreatedBot } from '../../apps/server/src/modules/bots/index.js';
import { createPgSyncStore } from '../../apps/server/src/modules/sync/index.js';
import { wsServerFrameSchema, type SyncResponse, type WsServerFrame } from '../../apps/server/src/shared.js';
import type { E2eContext } from './harness.js';

/** 봇 리스너(별도 루프백 포트) + 봇 1개·토큰 1개. 메인 앱과 같은 이벤트 인스턴스를 받는다(TRD §5-2 3·6항). */
export interface BotE2e {
  readonly app: ReturnType<typeof buildBotApp>;
  readonly port: number;
  readonly bot: CreatedBot;
  readonly token: string;
}

export async function setupBotE2e(ctx: E2eContext): Promise<BotE2e> {
  const services = ctx.app.domainServices;
  if (services === undefined) throw new Error('도메인 서비스 없음');
  const bots = createBotService({ pool: ctx.schema.pool, events: createBotEvents() });
  const bot = await bots.createBot({ displayName: 'Catchup Bot', slug: 'catchup-bot' });
  const issued = await bots.issueToken(bot.botUserId, 'adapter');
  const app = buildBotApp({
    bots,
    ...services,
    logger: { log: () => undefined },
    realtime: {
      syncStore: createPgSyncStore(ctx.schema.pool),
      conversationEvents: ctx.app.conversationEvents,
      messageEvents: ctx.app.messageEvents,
      readEvents: ctx.app.readEvents,
    },
  });
  const address = await listenBot(app, { HOST: '127.0.0.1' }, 0);
  return { app, port: address.port, bot, token: issued.token };
}

/** 봇 Bearer HTTP(실제 fetch). 상태 코드와 JSON을 그대로 돌려준다. */
export async function botFetch(b: BotE2e, method: string, path: string, payload?: unknown): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`http://127.0.0.1:${b.port}/api/bot/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${b.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? undefined : JSON.parse(text) };
}

/** 봇 sync 페이지를 끝까지 따라간다. */
export async function botSyncFrom(b: BotE2e, after: number): Promise<{ changes: SyncResponse['changes']; through: number }> {
  const changes: SyncResponse['changes'] = [];
  let query = `after=${after}&limit=100`;
  for (let i = 0; i < 1000; i += 1) {
    const res = await botFetch(b, 'GET', `sync?${query}`);
    if (res.status !== 200) throw new Error(`봇 sync 실패: ${res.status}`);
    const page = res.json as SyncResponse;
    changes.push(...page.changes);
    if (!page.has_more) return { changes, through: page.through_cursor };
    query = `after=${page.next_cursor}&through=${page.through_cursor}&limit=100`;
  }
  throw new Error('봇 sync 페이지 상한 초과');
}

/** 봇 WS 클라이언트(Bearer 헤더만, Origin·Cookie 없음). */
export interface BotWs {
  frames(): readonly WsServerFrame[];
  subscribe(conversationId: string, afterCursor: number): void;
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function openBotWs(b: BotE2e): Promise<BotWs> {
  const socket = new WebSocket(`ws://127.0.0.1:${b.port}/api/bot/v1/ws`, { headers: { authorization: `Bearer ${b.token}` } } as unknown as string[]);
  const frames: WsServerFrame[] = [];
  socket.addEventListener('message', (e) => frames.push(wsServerFrameSchema.parse(JSON.parse(String(e.data)))));
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  const client: BotWs = {
    frames: () => frames,
    subscribe: (conversationId, afterCursor) =>
      socket.send(JSON.stringify({ type: 'conversation.subscribe', conversation_id: conversationId, after_cursor: afterCursor })),
    async waitFor(pred, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`봇 WS 대기 시간 초과: ${frames.length} frames`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() {
      if (socket.readyState <= 1) socket.close();
      await closed;
    },
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(client));
    socket.addEventListener('error', () => reject(new Error('봇 WS 연결 거부')));
  });
}
