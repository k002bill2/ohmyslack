/** bots 모듈 공개 API(B1: 모듈 밖은 repo를 직접 import하지 않는다). 정본: TRD §5-2(ADR-001). */
export { BOT_TOKEN_PREFIX } from './token.js';
export { createBotEvents, type BotEvents, type BotConnectionsCloseEvent, type BotConnectionsCloseListener } from './events.js';
export {
  createBotService,
  MAX_LIVE_TOKENS,
  type BotService,
  type BotServiceDeps,
  type CreatedBot,
  type IssuedBotToken,
  type RotatedBotToken,
} from './service.js';
export type { BotRow } from './repo.js';
export { runBotAdmin } from './admin-cli.js';
export { buildBotApp, listenBot, resolveBotPort, type BotAppOptions } from './listener.js';
export { createBotRateLimiter, BOT_RATE_LIMITS, BOT_RATE_WINDOW_MS, type BotRateLimiter } from './rate-limit.js';
export { requireBot, type BotContext } from './routes.js';
export { BOT_WS_PATH, BOT_WS_SWEEP_MS, BOT_WS_END_REASON, type BotRealtimeDeps } from './ws.js';
