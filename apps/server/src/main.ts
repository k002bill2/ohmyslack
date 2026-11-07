import pg from 'pg';
import { buildApp } from './app.js';
import { listenLoopback, parsePort, resolveListenHost } from './bind.js';
import { createPgAuthStore } from './modules/auth/index.js';
import { createPgConversationsStore } from './modules/conversations/index.js';
import { createPgMembersStore } from './modules/members/index.js';
import { createPgMessagesStore } from './modules/messages/index.js';
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
// WEB_DIST_DIR(기본: apps/web/dist)이 없으면 정적 서빙 없이 API만 연다.
const webDistDir = resolveWebDistDir(process.env);
const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
const app = buildApp({ allowedOrigin: required('ALLOWED_ORIGIN'), authStore: createPgAuthStore(pool),
  membersStore: createPgMembersStore(pool),
  conversationsStore: createPgConversationsStore(pool),
  messagesStore: createPgMessagesStore(pool),
  syncStore: createPgSyncStore(pool),
  ...(webDistDir === undefined ? {} : { webDistDir }),
});
await listenLoopback(app, process.env, port);
