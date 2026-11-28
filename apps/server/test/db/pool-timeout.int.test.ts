import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appPoolConfig, createPool, withTransaction } from '../../src/db/pool.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { sendRaw } from '../messages/msg-int-harness.js';
import { createTestSchema, type TestSchema } from '../support/test-db.js';
import { checkTestDbUrl } from '../../../../tools/assert-test-db.js';

/**
 * 앱 pool 상한(db/pool.ts appPoolConfig): 연결 대기 상한(connectionTimeoutMillis)·서버측 idle_in_transaction_session_timeout.
 * 테스트는 운영 값 대신 짧은 상한을 주입한다(축척). 로그는 ops 로거 직렬화 결과(라인)로 검사한다.
 */
const CONNECT_MS = 300;
const IDLE_MS = 300;
const FIXED_CODE = /^[A-Za-z0-9_]{1,40}$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const escaped: unknown[] = [];
const onUncaught = (error: unknown): void => {
  escaped.push(error);
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitFor 시간 초과');
    await sleep(20);
  }
}

/** 로그 라인마다 error_code가 있으면 고정 코드 형식이고, 원시 메시지·연결 문자열 조각이 없다. */
function expectFixedCodeLogs(lines: readonly string[]): void {
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.error_code !== undefined) expect(String(record.error_code)).toMatch(FIXED_CODE);
    expect(line).not.toMatch(/timeout exceeded|terminat|postgres(ql)?:\/\/|idle-in-transaction/i);
  }
}

beforeEach(() => {
  escaped.length = 0;
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

describe('pool 연결 대기 상한(connectionTimeoutMillis)', () => {
  let ctx: ConvIntContext | undefined;
  const lines: string[] = [];

  afterEach(async () => {
    await teardownConvInt(ctx);
    ctx = undefined;
    lines.length = 0;
  });

  it('pool을 전부 점유하면 전송이 상한 안에 500 db_pool_timeout으로 끝나고, 해제 후 같은 client_message_id 재시도는 1건으로 수렴한다', async () => {
    ctx = await setupConvInt(
      { logger: createOpsLogger((line) => lines.push(line)) },
      { max: 2, timeouts: { connectionTimeoutMs: CONNECT_MS, idleInTransactionTimeoutMs: 30_000 } },
    );
    const { app, schema } = ctx;
    const a = await as(app, 'a');
    const general = await createChannel(app, a, 'general');
    const key = randomUUID();
    const payload = { client_message_id: key, body: '상한 재시도' };

    const held = [await schema.pool.connect(), await schema.pool.connect()];
    try {
      const started = Date.now();
      // 테스트측 상한: 연결 대기 상한이 없으면(변이) 요청이 끝나지 않으므로 단언 실패로 끝내고 finally에서 점유를 푼다.
      const bound = sleep(CONNECT_MS * 6).then(() => 'test_bound_exceeded' as const);
      const raced = await Promise.race([sendRaw(app, a, general, payload), bound]);
      expect(raced).not.toBe('test_bound_exceeded');
      if (raced === 'test_bound_exceeded') return;
      const failed = raced;
      const elapsed = Date.now() - started;
      expect(failed.statusCode).toBe(500);
      expect(failed.json<{ error: { code: string } }>().error.code).toBe('db_pool_timeout');
      expect(elapsed).toBeGreaterThanOrEqual(CONNECT_MS - 50);
      expect(elapsed).toBeLessThan(CONNECT_MS * 6);
      expect(failed.body).not.toMatch(/timeout exceeded|postgres/i);
    } finally {
      for (const client of held) client.release();
    }

    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ event: 'http_error', error_code: 'db_pool_timeout' }),
    );
    expectFixedCodeLogs(lines);

    // 해제 후: 같은 키 재시도는 생성(201), 한 번 더는 원래 결과(200) — 메시지 1건.
    const retried = await sendRaw(app, a, general, payload);
    expect(retried.statusCode).toBe(201);
    const again = await sendRaw(app, a, general, payload);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(retried.json());
    const count = await schema.pool.query<{ n: string }>('SELECT count(*) AS n FROM messages WHERE client_message_id = $1', [key]);
    expect(Number(count.rows[0]?.n)).toBe(1);
    expect(escaped).toEqual([]);
  });
});

describe('서버측 idle_in_transaction_session_timeout', () => {
  let schema: TestSchema | undefined;
  const lines: string[] = [];

  afterEach(async () => {
    await schema?.drop();
    schema = undefined;
    lines.length = 0;
  });

  const open = async (): Promise<TestSchema> =>
    createTestSchema({
      timeouts: { connectionTimeoutMs: 5000, idleInTransactionTimeoutMs: IDLE_MS },
      logger: createOpsLogger((line) => lines.push(line)),
    });

  it('기본 설정(appPoolConfig 기본값)이 실제 연결에 적용된다 — SHOW 30s, 전역 statement_timeout은 0', async () => {
    const raw = process.env.TEST_DATABASE_URL;
    const check = checkTestDbUrl(raw);
    if (!check.ok || raw === undefined) throw new Error(`assert-test-db 거부: ${check.reason}`);
    const pool = createPool({ ...appPoolConfig({ connectionString: raw }), max: 1 }, { log: () => undefined });
    try {
      const idle = await pool.query<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v");
      expect(idle.rows[0]?.v).toBe('30s');
      const statement = await pool.query<{ v: string }>("SELECT current_setting('statement_timeout') AS v");
      expect(statement.rows[0]?.v).toBe('0');
    } finally {
      await pool.end();
    }
  });

  it('withTransaction 안에서 상한을 넘겨 쉬면 서버가 세션을 끊고, 연결은 release(err)로 폐기되며 다음 쿼리는 새 연결로 정상이다', async () => {
    schema = await open();
    const { pool } = schema;
    const shown = await pool.query<{ v: string }>("SELECT current_setting('idle_in_transaction_session_timeout') AS v");
    expect(shown.rows[0]?.v).toBe(`${IDLE_MS}ms`);
    let txPid: number | undefined;

    const outcome = withTransaction(pool, async (client) => {
      txPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      await sleep(IDLE_MS * 3);
      await client.query('SELECT 1');
      return { commit: true, value: 'unreachable' };
    });
    await expect(outcome).rejects.toThrow();
    // 폐기된 연결은 pool에서 빠진다(이 pool의 유일한 연결이었으므로 0) — 끊긴 연결이 다시 대여되지 않는다.
    await waitFor(() => pool.totalCount === 0, 2000);
    const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(txPid).toBeTypeOf('number');
    expect(after.rows[0]?.pid).not.toBe(txPid);
    await sleep(50);
    expect(escaped).toEqual([]);
    expectFixedCodeLogs(lines);
  });

  it('트랜잭션을 연 채 반납된(누수) 유휴 연결은 서버가 끊고, pool error 처리기가 고정 코드 25P03만 로그하며 프로세스는 산다', async () => {
    schema = await open();
    const { pool } = schema;
    const leaked = await pool.connect();
    await leaked.query('BEGIN');
    leaked.release();

    await waitFor(() => lines.length > 0, 2000);
    await sleep(50);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({ event: 'db_pool_client_error', error_code: '25P03' });
    expectFixedCodeLogs(lines);
    expect(escaped).toEqual([]);
    expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one).toBe(1);
  });
});
