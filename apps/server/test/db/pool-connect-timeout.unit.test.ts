import net from 'node:net';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { appPoolConfig, DB_POOL_TIMEOUT_CODE, dbErrorCode, isPoolTimeout } from '../../src/db/pool.js';

describe('실제 pg-pool 접속 상한 초과 분류', () => {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let pool: pg.Pool | undefined;

  afterEach(async () => {
    await pool?.end().catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    pool = undefined;
    server = undefined;
  });

  it('접속만 받고 응답하지 않는 서버: pool.query가 reject되고 isPoolTimeout·db_pool_timeout으로 분류된다', async () => {
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    pool = new pg.Pool(
      appPoolConfig(
        { connectionString: `postgres://u:p@127.0.0.1:${port}/db` },
        { connectionTimeoutMs: 300, idleInTransactionTimeoutMs: 30_000 },
      ),
    );
    pool.on('error', () => undefined);

    const error = await pool.query('SELECT 1').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isPoolTimeout(error)).toBe(true);
    expect(dbErrorCode(error)).toBe(DB_POOL_TIMEOUT_CODE);
  });
});
