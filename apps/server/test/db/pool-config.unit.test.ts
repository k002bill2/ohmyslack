import { describe, expect, it } from 'vitest';
import {
  APP_POOL_TIMEOUTS,
  appPoolConfig,
  DB_POOL_TIMEOUT_CODE,
  dbErrorCode,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POOL_CONNECTION_TIMEOUT_MS,
  POOL_KEEPALIVE_INITIAL_DELAY_MS,
} from '../../src/db/pool.js';
import { toHttpError } from '../../src/http/errors.js';

describe('appPoolConfig(앱 pool 상한)', () => {
  it('기본값: 연결 대기 5초·서버측 idle_in_transaction 30초·keepalive 10초, 전역 statement_timeout 없음', () => {
    expect(POOL_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(30_000);
    expect(POOL_KEEPALIVE_INITIAL_DELAY_MS).toBe(10_000);
    const config = appPoolConfig({ connectionString: 'postgres://u@127.0.0.1:5432/db' });
    expect(config).toEqual({
      connectionString: 'postgres://u@127.0.0.1:5432/db',
      options: '-c idle_in_transaction_session_timeout=30000',
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    expect(JSON.stringify(config)).not.toContain('statement_timeout=');
    expect(APP_POOL_TIMEOUTS).toEqual({ connectionTimeoutMs: 5000, idleInTransactionTimeoutMs: 30_000 });
  });

  it('연결 문자열의 options 쿼리는 떼어 내 앞에 두고(pg가 config.options를 덮지 않게) 상한 설정을 뒤에 붙인다', () => {
    const config = appPoolConfig(
      { connectionString: 'postgres://u@127.0.0.1/db?options=-c%20search_path%3Dx&sslmode=disable', options: '-c work_mem=4MB' },
      { connectionTimeoutMs: 250, idleInTransactionTimeoutMs: 400 },
    );
    expect(config.connectionString).toBe('postgres://u@127.0.0.1/db?sslmode=disable');
    expect(config.options).toBe('-c search_path=x -c work_mem=4MB -c idle_in_transaction_session_timeout=400');
    expect(config.connectionTimeoutMillis).toBe(250);
  });

  it('URL이 아닌 연결 문자열(키=값 형식)은 그대로 둔다', () => {
    expect(appPoolConfig({ connectionString: 'host=/tmp dbname=db' }).connectionString).toBe('host=/tmp dbname=db');
  });
});

describe('pool 대기 상한 초과의 고정 코드', () => {
  const waitTimeout = new Error('timeout exceeded when trying to connect');
  const connectTimeout = new Error('Connection terminated due to connection timeout');

  it('dbErrorCode: pg-pool 상한 오류(code 없음)는 db_pool_timeout, 그 밖의 code 없는 오류는 connection_lost', () => {
    expect(dbErrorCode(waitTimeout)).toBe(DB_POOL_TIMEOUT_CODE);
    expect(dbErrorCode(connectTimeout)).toBe(DB_POOL_TIMEOUT_CODE);
    expect(dbErrorCode(new Error('Connection terminated unexpectedly'))).toBe('connection_lost');
    expect(dbErrorCode(Object.assign(new Error('x'), { code: '25P03' }))).toBe('25P03');
  });

  it('toHttpError: 500 db_pool_timeout(503이 아님 — 웹은 503을 게이트웨이 끊김으로 센다), 다른 DB 오류는 500 internal_error', () => {
    expect(toHttpError(waitTimeout)).toMatchObject({ statusCode: 500, code: 'db_pool_timeout' });
    expect(toHttpError(connectTimeout)).toMatchObject({ statusCode: 500, code: 'db_pool_timeout' });
    expect(toHttpError(Object.assign(new Error('terminating'), { code: '25P03' }))).toMatchObject({ statusCode: 500, code: 'internal_error' });
  });
});
