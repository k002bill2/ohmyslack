import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { BOT_ROUTE_PREFIX } from '../../http/access.js';
import { WS_FRAME_MAX_BYTES, WS_HEARTBEAT_MS } from '../../shared.js';
import type { AuthEvents } from '../auth/events.js';
import type { ConversationEvents } from '../conversations/events.js';
import type { ConversationsService } from '../conversations/service.js';
import type { MessageEvents } from '../messages/events.js';
import type { MessageRecord } from '../messages/store.js';
import type { MetricsRecorder } from '../ops/metrics.js';
import { createHub, serveSocket, type Hub, type HubAuth } from '../realtime/index.js';
import type { ReadEvents } from '../sync/events.js';
import type { SyncStore } from '../sync/store.js';
import type { BotEvents } from './events.js';
import { botTokenGuard } from './routes.js';
import type { BotService } from './service.js';

/** 봇 WS 경로(TRD §5-2 6항). 프레임 계약은 사람 `/api/ws`와 같은 shared 스키마다. */
export const BOT_WS_PATH = `${BOT_ROUTE_PREFIX}ws`;
/**
 * 봇 토큰 재검증 sweep 주기(TRD §5-2 2항 "폐기·비활성화 후 5초 안에 close"). 폐기·비활성화는 CLI(별도 프로세스)에서
 * 일어나 같은 프로세스 이벤트로 오지 않는다. 최악 지연 ≈ 주기 + 일괄 쿼리 1회라 2초로 둔다.
 */
export const BOT_WS_SWEEP_MS = 2000;
/** 봇 WS close 사유(코드는 사람 WS와 같은 1008 정책 위반, TRD §5-1 S7·TR-SEC-04 "같은 sweep"). */
export const BOT_WS_END_REASON = 'token_revoked';
/** 봇 토큰은 만료 시각이 없다(§5-2 2항, ADR-001 D-7). 허브 만료 타이머는 상한 지연마다 재확인만 한다. */
const NO_EXPIRY = new Date(8.64e15);

/** 메인 앱과 **같은** 이벤트 인스턴스(commit 후 발행)를 받는다. 다르면 봇 WS가 아무것도 받지 못한다. */
export interface BotRealtimeDeps {
  readonly syncStore: SyncStore;
  readonly conversationEvents: ConversationEvents;
  readonly messageEvents: MessageEvents;
  readonly readEvents: ReadEvents;
  /** 같은 프로세스의 폐기·비활성화(onConnectionsClose) 즉시 닫기. CLI 프로세스 경로는 sweep이 잡는다. */
  readonly botEvents?: BotEvents;
  readonly heartbeatMs?: number;
  readonly sweepMs?: number;
}

/** 봇 토큰을 허브 인증 면으로: 연결 식별자 = 토큰 ID, 재확인·sweep = 토큰 ID 일괄 조회(last_used_at 불변). */
function tokenAuth(bots: BotService): HubAuth {
  return {
    async peek(tokenId) {
      const live = await bots.liveTokenIds([tokenId]);
      return live.has(tokenId) ? { session: { id: tokenId, expiresAt: NO_EXPIRY } } : undefined;
    },
    liveSessionIds: (tokenIds) => bots.liveTokenIds(tokenIds),
  };
}

function revokeEvents(botEvents: BotEvents | undefined): Pick<AuthEvents, 'onSessionRevoked'> {
  return {
    onSessionRevoked(listener) {
      if (botEvents === undefined) return () => undefined;
      const off = botEvents.onConnectionsClose((event) => listener(event.tokenIds));
      return () => {
        off();
      };
    },
  };
}

/**
 * 봇 수신(in: 서버 → 봇 WS 새 메시지 전달) 계측 입력. 방향은 봇 관점(ADR-001 "수신(사람→Jarvis)").
 * 지연 = 전달 시각 - 메시지 생성(커밋) 시각. 식별자·본문은 싣지 않는다.
 */
export function botReceiveMetric(message: MessageRecord, delivered: boolean, now: number): Readonly<Record<string, unknown>> {
  return {
    event: 'bot_delivery_result',
    direction: 'in',
    outcome: delivered ? 'ok' : 'failed',
    has_attachment: (message.attachments ?? []).length > 0,
    duration_ms: now - message.createdAt.getTime(),
  };
}

export interface BotWsOptions {
  readonly bots: BotService;
  readonly conversations: ConversationsService;
  readonly clock: () => number;
  readonly realtime: BotRealtimeDeps;
  /** 있으면 서버 → 봇 새 메시지 전달(봇 수신, in)을 `bot_delivery_result`로 기록한다. 지연 = 전달 시각 - 메시지 생성 시각. */
  readonly metrics?: MetricsRecorder;
}

/**
 * `GET /api/bot/v1/ws`: Bearer handshake(`botTokenGuard`, 같은 verifyToken) → 사람 WS와 같은 허브 규칙
 * (전달 직전 토큰·멤버십 재확인, 멤버십 종료 시 구독 종료, sweep). Origin·Cookie 동봉 업그레이드는 리스너 onRequest가 400.
 */
export function registerBotRealtime(app: FastifyInstance, options: BotWsOptions): Hub {
  const { bots, conversations, clock, realtime, metrics } = options;
  const hub = createHub({
    auth: tokenAuth(bots),
    conversations,
    syncStore: realtime.syncStore,
    authEvents: revokeEvents(realtime.botEvents),
    conversationEvents: realtime.conversationEvents,
    messageEvents: realtime.messageEvents,
    readEvents: realtime.readEvents,
    clock,
    sweepMs: realtime.sweepMs ?? BOT_WS_SWEEP_MS,
    endReason: BOT_WS_END_REASON,
    botScope: { visibleMessageIds: (userId, ids) => bots.visibleMessageIds(userId, ids) },
    ...(metrics === undefined
      ? {}
      : {
          onMessageDelivered: (message: MessageRecord, delivered: boolean) => metrics.record(botReceiveMetric(message, delivered, clock())),
        }),
  });
  const heartbeatMs = realtime.heartbeatMs ?? WS_HEARTBEAT_MS;
  app.addHook('onClose', async () => hub.dispose());
  void app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: WS_FRAME_MAX_BYTES } });
    scope.get(BOT_WS_PATH, { websocket: true, config: { access: 'bot' }, preHandler: botTokenGuard(bots) }, (socket, request) => {
      const bot = request.bot;
      if (bot === undefined) return socket.close(1008, 'unauthenticated');
      serveSocket(hub, socket, { userId: bot.botUserId, sessionId: bot.tokenId, token: bot.tokenId, expiresAt: NO_EXPIRY }, heartbeatMs);
      return undefined;
    });
  });
  return hub;
}
