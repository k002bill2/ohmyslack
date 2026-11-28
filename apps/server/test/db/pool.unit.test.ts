import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPool, withTransaction } from '../../src/db/pool.js';

/** 체크아웃 클라이언트 흉내: 'error' 이벤트를 내는 EventEmitter + query·release. fail이 참인 SQL은 거부한다. */
function fakeClient(fail: (sql: string) => boolean = () => false) {
  const calls: string[] = [];
  const release = vi.fn();
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (fail(sql)) throw new Error(`실패: ${sql}`);
      return { rows: [], rowCount: 0 };
    }),
    release,
  });
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { client, calls, release, pool };
}

const asPoolClient = (c: unknown): pg.PoolClient => c as pg.PoolClient;

describe('withTransaction', () => {
  it('commit이면 BEGIN→작업→COMMIT 후 release()로 돌려주고 error 리스너를 남기지 않는다', async () => {
    const fx = fakeClient();
    const value = await withTransaction(fx.pool, async (client) => {
      expect(fx.client.listenerCount('error')).toBe(1);
      await client.query('SELECT 1');
      return { commit: true, value: 7 };
    });
    expect(value).toBe(7);
    expect(fx.calls).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(fx.release).toHaveBeenCalledTimes(1);
    expect(fx.release).toHaveBeenCalledWith();
    expect(fx.client.listenerCount('error')).toBe(0);
  });

  it('commit=false면 ROLLBACK 후 값만 돌려준다', async () => {
    const fx = fakeClient();
    const value = await withTransaction(fx.pool, async () => ({ commit: false, value: 'no' }));
    expect(value).toBe('no');
    expect(fx.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fx.release).toHaveBeenCalledWith();
    expect(fx.client.listenerCount('error')).toBe(0);
  });

  it('작업 오류이고 ROLLBACK이 성공하면 연결은 건강하다 — 오류를 다시 던지고 release()로 돌려준다', async () => {
    const fx = fakeClient();
    const boom = new Error('업무 오류');
    await expect(
      withTransaction(fx.pool, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fx.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fx.release).toHaveBeenCalledWith();
    expect(fx.client.listenerCount('error')).toBe(0);
  });

  it('ROLLBACK마저 실패하면 연결을 폐기한다 — release(err)', async () => {
    const fx = fakeClient((sql) => sql === 'SELECT 1' || sql === 'ROLLBACK');
    await expect(withTransaction(fx.pool, async (client) => ({ commit: true, value: await client.query('SELECT 1') }))).rejects.toThrow('실패: SELECT 1');
    expect(fx.release).toHaveBeenCalledTimes(1);
    expect(fx.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(fx.client.listenerCount('error')).toBe(0);
  });

  it('사용 중 클라이언트가 error를 내도(연결 종료) 던지지 않고, 그 연결은 release(err)로 폐기한다', async () => {
    const fx = fakeClient();
    const terminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const value = await withTransaction(fx.pool, async (client) => {
      // 리스너가 없으면 EventEmitter.emit('error')는 동기적으로 throw한다(= 운영의 Unhandled 'error' event).
      fx.client.emit('error', terminated);
      expect(asPoolClient(client)).toBe(fx.client);
      return { commit: false, value: 'after' };
    });
    expect(value).toBe('after');
    expect(fx.release).toHaveBeenCalledWith(terminated);
    expect(fx.client.listenerCount('error')).toBe(0);
  });

  it('BEGIN부터 실패하면(체크아웃 직후 끊김) 오류를 던지고 release(err)로 폐기한다', async () => {
    const fx = fakeClient((sql) => sql === 'BEGIN' || sql === 'ROLLBACK');
    const work = vi.fn(async () => ({ commit: true, value: 1 }));
    await expect(withTransaction(fx.pool, work)).rejects.toThrow('실패: BEGIN');
    expect(work).not.toHaveBeenCalled();
    expect(fx.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(fx.client.listenerCount('error')).toBe(0);
  });
});

describe('withTransaction 깨진 연결 로그', () => {
  it('연결이 깨져 release(err)할 때만 고정 코드 1줄을 남긴다 — 메시지·SQL 없음', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = { log: (f: Readonly<Record<string, unknown>>) => lines.push({ ...f }) };
    const healthy = fakeClient();
    await withTransaction(healthy.pool, async () => ({ commit: true, value: 1 }), logger);
    expect(lines).toEqual([]);

    const fx = fakeClient();
    const idle = Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' });
    await withTransaction(fx.pool, async () => {
      fx.client.emit('error', idle);
      return { commit: false, value: 0 };
    }, logger);
    expect(lines).toEqual([{ event: 'db_tx_connection_broken', error_code: '25P03' }]);
    expect(JSON.stringify(lines)).not.toMatch(/idle-in-transaction|SELECT|ROLLBACK/);
  });
});

describe('createPool', () => {
  it("유휴 클라이언트 오류(pool 'error')를 던지지 않고 코드만 로그한다 — 연결 문자열·메시지는 남기지 않는다", async () => {
    const lines: Record<string, unknown>[] = [];
    const pool = createPool({ connectionString: 'postgres://user:s3cret@127.0.0.1:1/never' }, { log: (f) => lines.push({ ...f }) });
    expect(() => pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).not.toThrow();
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(lines).toEqual([
      { event: 'db_pool_client_error', error_code: '57P01' },
      { event: 'db_pool_client_error', error_code: 'connection_lost' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('s3cret');
    await pool.end();
  });
});
