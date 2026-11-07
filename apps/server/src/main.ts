import pg from 'pg';
import { buildApp } from './app.js';
import { assertLoopbackBind, parsePort } from './bind.js';
import { createPgAuthStore } from './modules/auth/index.js';
import { createPgMembersStore } from './modules/members/index.js';

/** 프로세스 진입점. 바인드 검사는 리스너를 열기 전에 수행한다(NC-05). */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`환경 변수 ${name} 미설정`);
  return value;
}

const host = assertLoopbackBind(process.env.HOST);
const port = parsePort(required('PORT'));
const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
const app = buildApp({ allowedOrigin: required('ALLOWED_ORIGIN'), authStore: createPgAuthStore(pool),
  membersStore: createPgMembersStore(pool),
});
await app.listen({ host, port });
