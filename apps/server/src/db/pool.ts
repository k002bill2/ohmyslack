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

/**
 * 앱 pool의 연결 대기·접속 상한. pg-pool 기본값(0)은 무한 대기라, 연결이 전부 쥐인 채 정착하지 않으면(RST 없는 죽은 소켓 등)
 * 요청·계측 대기자가 끝없이 쌓인다. 정상 요청은 수십 ms 안에 연결을 얻고, 웹 요청 상한(REQUEST_TIMEOUT_MS 20초)보다 충분히 짧게
 * 끝나야 클라이언트가 응답(5xx, 재시도 가능)을 받는다 — 5초.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 5000;
/**
 * 서버측 idle_in_transaction_session_timeout(앱 pool 연결에만). 트랜잭션을 열고 외부 I/O를 기다리는 정상 경로는 없으므로
 * 이 상한을 넘긴 세션은 버그(누수된 트랜잭션)다 — Postgres가 세션을 끊어(25P03) 잠금·연결을 돌려받는다. 계측 store의
 * 트랜잭션 로컬 statement_timeout(3초)과는 다른 GUC라 우선순위 충돌이 없다(그 트랜잭션은 활성 상태이고 수 초 안에 끝난다).
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
/**
 * TCP keepalive 첫 탐침까지의 유휴 시간. pg 기본 0은 OS 기본(macOS·Linux 7200초)을 쓰므로 RST 없이 끊긴 소켓을 2시간 넘게 못 본다.
 * 10초 뒤부터 탐침하면 죽은 연결이 탐침 간격·횟수(OS 기본 — 이 Mac sysctl 실측 75초×8 — 또는 libuv가 덮어쓴 값) 뒤 오류로 끝나
 * release(err)·pool 'error'로 정리된다.
 * 살아 있는 연결에는 유휴 10초마다 빈 ACK 1개뿐이라 부작용은 무시할 수준이다.
 */
export const POOL_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
/** pool 대기 상한 초과의 고정 코드(pg-pool 오류에는 code가 없다). */
export const DB_POOL_TIMEOUT_CODE = 'db_pool_timeout';

/** pg-pool이 connectionTimeoutMillis에서 내는 오류 메시지(대기열 대기 초과 / 새 연결 접속 초과). code가 없어 메시지로만 구분된다. */
const POOL_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

/** pool 대기·접속 상한 초과인지(connectionTimeoutMillis). */
export function isPoolTimeout(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === undefined && POOL_TIMEOUT_MESSAGES.has(error.message);
}

/** SQLSTATE·소켓 오류 코드만 남긴다. 메시지·연결 문자열은 로그하지 않는다(B6). */
export function dbErrorCode(error: unknown): string {
  if (isPoolTimeout(error)) return DB_POOL_TIMEOUT_CODE;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'connection_lost';
}

/** 앱 pool 상한(테스트는 짧게 주입). */
export interface AppPoolTimeouts {
  readonly connectionTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

export const APP_POOL_TIMEOUTS: AppPoolTimeouts = Object.freeze({
  connectionTimeoutMs: POOL_CONNECTION_TIMEOUT_MS,
  idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
});

/**
 * 앱 프로세스 pool 설정(CLI는 각자 별도 pool — 적용하지 않는다). 전역 statement_timeout은 두지 않는다(첨부·snapshot 실측 전).
 * pg는 연결 문자열의 `options` 쿼리가 config.options를 덮으므로, 있으면 떼어 내 앞에 두고 상한 설정을 뒤에 붙인다.
 */
export function appPoolConfig(
  base: { readonly connectionString: string; readonly options?: string },
  timeouts: AppPoolTimeouts = APP_POOL_TIMEOUTS,
): pg.PoolConfig {
  const { connectionString, urlOptions } = splitUrlOptions(base.connectionString);
  const idle = `-c idle_in_transaction_session_timeout=${Math.trunc(timeouts.idleInTransactionTimeoutMs)}`;
  const options = [urlOptions, base.options, idle].filter((part) => part !== undefined && part !== '').join(' ');
  return {
    connectionString,
    options,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_KEEPALIVE_INITIAL_DELAY_MS,
  };
}

/** URL 형식이 아니거나 options 쿼리가 없으면 연결 문자열을 그대로 둔다(재직렬화로 인코딩이 바뀌지 않게). */
function splitUrlOptions(connectionString: string): { connectionString: string; urlOptions?: string } {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return { connectionString };
  }
  const urlOptions = parsed.searchParams.get('options');
  if (urlOptions === null) return { connectionString };
  parsed.searchParams.delete('options');
  return { connectionString: parsed.toString(), urlOptions };
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
