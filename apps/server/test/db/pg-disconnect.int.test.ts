import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTestDbUrl } from '../../../../tools/assert-test-db.js';
import { withTransaction } from '../../src/db/pool.js';
import { as, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';

/**
 * Postgres 연결 종료(관리자 종료 57P01 / Connection terminated unexpectedly)에도 프로세스가 죽지 않고 다음 요청이 재연결로 200인지.
 * 종료 대상은 이 테스트 실행 고유의 application_name(PGAPPNAME) 연결뿐이다 — 다른 세션·운영 연결은 건드리지 않는다.
 */
const APP_NAME = `ohmyslack_pgerr_${process.pid}_${randomBytes(4).toString('hex')}`;
const ADMIN_NAME = `${APP_NAME}_admin`;

let ctx: ConvIntContext;
let previousAppName: string | undefined;
const escaped: unknown[] = [];
const onUncaught = (error: unknown): void => {
  escaped.push(error);
};

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  const check = checkTestDbUrl(raw);
  if (!check.ok || raw === undefined) throw new Error(`assert-test-db 거부: ${check.reason}`);
  return raw;
}

async function withAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), application_name: ADMIN_NAME });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** 이 테스트의 application_name 연결만 종료하고, 서버 쪽에서 사라질 때까지 기다린다. 종료한 수를 돌려준다. */
async function terminateOwnConnections(): Promise<number> {
  return withAdmin(async (admin) => {
    const res = await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = $1 AND datname = current_database() AND pid <> pg_backend_pid()`,
      [APP_NAME],
    );
    await waitFor(async () => {
      const left = await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [APP_NAME]);
      return (left.rowCount ?? 0) === 0;
    });
    return res.rowCount ?? 0;
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitFor 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  escaped.length = 0;
  previousAppName = process.env.PGAPPNAME;
  process.env.PGAPPNAME = APP_NAME;
  process.on('uncaughtException', onUncaught);
  ctx = await setupConvInt();
});

afterEach(async () => {
  process.off('uncaughtException', onUncaught);
  await teardownConvInt(ctx);
  if (previousAppName === undefined) delete process.env.PGAPPNAME;
  else process.env.PGAPPNAME = previousAppName;
});

describe('Postgres 연결 종료 내성', () => {
  it('유휴 연결이 관리자 종료(57P01)돼도 처리되지 않은 error 없이 살아 있고 다음 요청이 200이다', async () => {
    const a = await as(ctx.app, 'a');
    expect((await req(ctx.app, 'GET', '/api/conversations', a)).statusCode).toBe(200);
    expect(ctx.schema.pool.idleCount).toBeGreaterThan(0);

    expect(await terminateOwnConnections()).toBeGreaterThan(0);
    // pg Pool은 오류 난 유휴 클라이언트를 버린다 — 전부 버려질 때까지 기다린다.
    await waitFor(() => ctx.schema.pool.totalCount === 0);
    await sleep(50);

    expect(escaped).toEqual([]);
    expect((await req(ctx.app, 'GET', '/api/conversations', a)).statusCode).toBe(200);
  });

  it('트랜잭션 도중 연결이 끊기면 그 작업만 실패하고, 처리되지 않은 error 없이 다음 요청이 200이다', async () => {
    const a = await as(ctx.app, 'a');
    const outcome = withTransaction(ctx.schema.pool, async (client) => {
      await client.query('SELECT 1');
      await terminateOwnConnections();
      // 서버가 보낸 FATAL 57P01·소켓 종료가 체크아웃 클라이언트에 도착할 시간을 준다.
      await sleep(200);
      await client.query('SELECT 1');
      return { commit: true, value: 'unreachable' };
    });
    await expect(outcome).rejects.toThrow();
    await sleep(50);

    expect(escaped).toEqual([]);
    expect((await req(ctx.app, 'GET', '/api/conversations', a)).statusCode).toBe(200);
  });
});
