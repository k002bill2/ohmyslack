import pg from 'pg';
import { buildApp } from './app.js';
import { listenLoopback, parsePort, resolveListenHost } from './bind.js';
import { createPgAuthStore } from './modules/auth/index.js';
import { buildBotApp, createBotEvents, createBotService, listenBot, resolveBotPort } from './modules/bots/index.js';
import { createPgConversationsStore } from './modules/conversations/index.js';
import { createPgMembersStore } from './modules/members/index.js';
import { createPgMessagesStore } from './modules/messages/index.js';
import { createOpsLogger } from './modules/ops/logger.js';
import { createPgSyncStore } from './modules/sync/index.js';
import { resolveWebDistDir } from './static/index.js';

/** 프로세스 진입점. 바인드 검사는 리스너를 열기 전에 수행한다(NC-05). */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`환경 변수 ${name} 미설정`);
  return value;
}

resolveListenHost(process.env);
const port = parsePort(required('PORT'));
// BOT_PORT가 없으면 봇 리스너를 열지 않는다(기본값 없음, TRD §5-2 3항). PORT와 같으면 기동 거부.
const botPort = resolveBotPort(process.env, port);
// WEB_DIST_DIR(기본: apps/web/dist)이 없으면 정적 서빙 없이 API만 연다.
const webDistDir = resolveWebDistDir(process.env);
const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
const logger = createOpsLogger();
const app = buildApp({ allowedOrigin: required('ALLOWED_ORIGIN'), authStore: createPgAuthStore(pool),
  membersStore: createPgMembersStore(pool),
  conversationsStore: createPgConversationsStore(pool),
  messagesStore: createPgMessagesStore(pool),
  syncStore: createPgSyncStore(pool),
  logger,
  ...(webDistDir === undefined ? {} : { webDistDir }),
});
await listenLoopback(app, process.env, port);

const services = app.domainServices;
// 봇 연결 닫기 훅(폐기·비활성화)은 CLI 프로세스에서 발행된다. 봇 WS sweep 연결은 다음 레인(p1-w18b2).
const botApp =
  botPort === undefined || services === undefined
    ? undefined
    : buildBotApp({ bots: createBotService({ pool, events: createBotEvents() }), ...services, logger });
if (botApp !== undefined && botPort !== undefined) await listenBot(botApp, process.env, botPort);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([app.close(), botApp?.close()]);
  await pool.end();
}
// 종료 동작을 "close 후 즉시 exit"로 한정한다 — 남은 타이머가 있어도 프로세스가 매달리지 않게(기존 기본 종료와 같은 결과).
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown().finally(() => process.exit(0)));
