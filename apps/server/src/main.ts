import { buildApp } from './app.js';
import { listenLoopback, parsePort, resolveListenHost } from './bind.js';
import { createPool } from './db/pool.js';
import { createPgAttachmentsStore, startRetentionTimer } from './modules/attachments/index.js';
import { createPgAuthStore } from './modules/auth/index.js';
import { buildBotApp, createBotEvents, createBotService, listenBot, resolveBotPort } from './modules/bots/index.js';
import { createPgConversationsStore } from './modules/conversations/index.js';
import { createPgMembersStore } from './modules/members/index.js';
import { createPgMessagesStore } from './modules/messages/index.js';
import { createOpsLogger } from './modules/ops/logger.js';
import { createMetricsRecorder, startMetricRetention } from './modules/ops/metrics.js';
import { createPgMetricsStore } from './modules/ops/metrics-store.js';
import { createPgPushStore, loadPushConfig } from './modules/push/index.js';
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
const logger = createOpsLogger();
// 'error' 처리기 포함: 유휴 연결이 끊겨도(57P01 등) 프로세스를 유지하고 다음 요청은 새 연결을 쓴다.
const pool = createPool({ connectionString: required('DATABASE_URL') }, logger);
const syncStore = createPgSyncStore(pool);
// PUSH_VAPID_KEY_FILE·PUSH_VAPID_SUBJECT 미설정·형식 위반이면 push만 비활성(기동 계속, TRD §6-2).
const pushConfig = loadPushConfig(process.env, logger);
// 로컬 계측(PRD §10): metric_daily 일 단위 집계. 마이그레이션 0009 전이면 기록·삭제가 실패해도 코드만 로그하고 요청은 그대로다.
const metricsStore = createPgMetricsStore(pool);
const metrics = createMetricsRecorder({ store: metricsStore, clock: Date.now, onError: () => logger.log({ event: 'metric_error', error_code: 'metric_write_failed' }) });
const stopMetricRetention = startMetricRetention(metricsStore, Date.now, () => logger.log({ event: 'metric_retention_error', error_code: 'metric_retention_failed' }));
const app = buildApp({ allowedOrigin: required('ALLOWED_ORIGIN'), authStore: createPgAuthStore(pool),
  membersStore: createPgMembersStore(pool),
  conversationsStore: createPgConversationsStore(pool),
  messagesStore: createPgMessagesStore(pool),
  syncStore,
  attachmentsStore: createPgAttachmentsStore(pool),
  pushStore: createPgPushStore(pool),
  push: pushConfig === undefined ? {} : { config: pushConfig },
  logger,
  metrics,
  ...(webDistDir === undefined ? {} : { webDistDir }),
});
await listenLoopback(app, process.env, port);

const services = app.domainServices;
// 봇 WS는 메인과 같은 이벤트 인스턴스를 구독한다. CLI(별도 프로세스)의 폐기·비활성화는 봇 WS sweep(2초)이 잡는다.
const botEvents = createBotEvents();
const botApp =
  botPort === undefined || services === undefined
    ? undefined
    : buildBotApp({
        bots: createBotService({ pool, events: botEvents }),
        ...services,
        logger,
        metrics,
        realtime: {
          syncStore,
          conversationEvents: app.conversationEvents,
          messageEvents: app.messageEvents,
          readEvents: app.readEvents,
          botEvents,
        },
      });
if (botApp !== undefined && botPort !== undefined) await listenBot(botApp, process.env, botPort);

// 첨부 보존 삭제(TRD §6-1): 미결속 1시간·보존 기한 경과·삭제 메시지의 바이트. 5분 주기, shutdown에서 멈춘다.
const attachmentsService = services?.attachments;
const stopRetention =
  attachmentsService === undefined
    ? undefined
    : startRetentionTimer(attachmentsService, 5 * 60 * 1000, () => logger.log({ event: 'attachment_retention_error', error_code: 'retention_failed' }));

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  stopRetention?.();
  stopMetricRetention();
  await Promise.allSettled([app.close(), botApp?.close()]);
  await pool.end();
}
// 종료 동작을 "close 후 즉시 exit"로 한정한다 — 남은 타이머가 있어도 프로세스가 매달리지 않게(기존 기본 종료와 같은 결과).
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown().finally(() => process.exit(0)));
