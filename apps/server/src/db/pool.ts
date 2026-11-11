import pg from 'pg';
import type { OpsLogger } from '../modules/ops/logger.js';

/**
 * Postgres 연결 끊김(관리자 종료 57P01, `Connection terminated unexpectedly`)이 프로세스를 죽이지 않게 하는 경계.
 * - 유휴 클라이언트 오류: pg Pool이 그 클라이언트를 버린 뒤 pool 'error'를 낸다 → 처리기가 코드만 로그한다. 다음 요청은 새 연결.
 * - 체크아웃 클라이언트 오류: pg-pool은 체크아웃 동안 자기 리스너를 떼므로, 직접 connect()하는 경로는 withTransaction만 쓴다.
 * (`pool.query`는 pg-pool이 체크아웃 동안 자체 'error' 리스너를 붙이므로 별도 처리 불필요.)
 */
type PoolLogger = Pick<OpsLogger, 'log'>;

const ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

/** SQLSTATE·소켓 오류 코드만 남긴다. 메시지·연결 문자열은 로그하지 않는다(B6). */
export function dbErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'connection_lost';
}

/** 'error' 처리기를 단 풀. 처리기가 없으면 유휴 연결 종료 하나로 Unhandled 'error' event가 되어 프로세스가 끝난다. */
export function createPool(config: pg.PoolConfig, logger: PoolLogger): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', (error) => {
    logger.log({ event: 'db_pool_client_error', error_code: dbErrorCode(error) });
  });
  return pool;
}

/** 작업 결과의 `commit`이 false면 ROLLBACK 후 value만 돌려준다(거부 시 DB 무변경). */
export interface TxOutcome<T> {
  readonly commit: boolean;
  readonly value: T;
}

/**
 * 트랜잭션 공통 경계. 안에서는 받은 client만 쓴다(풀 고갈 시 교착 방지).
 * 체크아웃 동안 client 'error'를 받아 두고(던지지 않음), 연결이 깨졌으면(client 오류 또는 ROLLBACK 실패) release(err)로 폐기한다.
 */
export async function withTransaction<T>(pool: Pick<pg.Pool, 'connect'>, work: (client: pg.PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (error: Error): void => {
    broken ??= error;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const outcome = await work(client);
    await client.query(outcome.commit ? 'COMMIT' : 'ROLLBACK');
    return outcome.value;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      broken ??= rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK 실패');
    });
    throw error;
  } finally {
    client.removeListener('error', onError);
    if (broken === undefined) client.release();
    else client.release(broken);
  }
}
