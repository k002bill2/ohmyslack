import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { checkTestDbUrl } from '../../../../tools/assert-test-db.js';
import { APP_POOL_TIMEOUTS, appPoolConfig, createPool, type AppPoolTimeouts } from '../../src/db/pool.js';
import type { OpsLogger } from '../../src/modules/ops/logger.js';

/** 통합 테스트 DB 하네스(정본: DEV_DESIGN §5-1 "테스트 DB 안전장치"). 실행 ID별 스키마 t_<runid>만 만들고 지운다. */
const SCHEMA_PATTERN = /^t_[a-z0-9_]+$/;

export interface TestSchema {
  readonly name: string;
  /** search_path가 이 스키마로 고정된 풀. */
  readonly pool: pg.Pool;
  drop(): Promise<void>;
}

/** assert-test-db 검사를 통과한 URL만 돌려준다. 실패 사유에는 URL 원문을 넣지 않는다. */
function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  const check = checkTestDbUrl(raw);
  if (!check.ok || raw === undefined) throw new Error(`assert-test-db 거부: ${check.reason}`);
  return raw;
}

function newSchemaName(): string {
  const name = `t_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  if (!SCHEMA_PATTERN.test(name)) throw new Error(`테스트 스키마 이름 형식 위반: ${name}`);
  return name;
}

async function withAdmin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** URL의 options 쿼리가 search_path를 덮지 않도록 떼어 내고, 실행 스키마 search_path를 마지막에 둔다. */
function isolatedConfig(url: string, schema: string): { connectionString: string; options: string } {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get('options');
  parsed.searchParams.delete('options');
  const options = [existing, `-c search_path=${schema}`].filter((part) => part !== null && part !== '').join(' ');
  return { connectionString: parsed.toString(), options };
}

async function dropSchema(url: string, name: string): Promise<void> {
  await withAdmin(url, (client) => client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
}

/** 풀 옵션: 앱 pool 설정(appPoolConfig, main.ts와 같은 경로)을 쓰고, timeouts가 없으면 운영 기본 상한이다(테스트는 짧게 주입). */
export interface TestSchemaOptions {
  readonly max?: number;
  readonly timeouts?: AppPoolTimeouts;
  readonly logger?: Pick<OpsLogger, 'log'>;
}

/** 빈 실행 스키마를 만들고 search_path를 그 스키마로 둔 풀을 돌려준다(마이그레이션은 호출자가 적용). */
export async function createTestSchema(options: TestSchemaOptions = {}): Promise<TestSchema> {
  const url = testDatabaseUrl();
  const name = newSchemaName();
  await withAdmin(url, (client) => client.query(`CREATE SCHEMA "${name}"`));
  // 운영과 같은 풀 팩토리('error' 처리기 포함)를 쓴다.
  const base = isolatedConfig(url, name);
  const config = appPoolConfig(base, options.timeouts ?? APP_POOL_TIMEOUTS);
  const pool = createPool({ ...config, max: options.max ?? 4 }, options.logger ?? { log: () => undefined });
  const current = await pool.query<{ schema: string }>('SELECT current_schema() AS schema').catch(() => undefined);
  if (current?.rows[0]?.schema !== name) {
    await pool.end();
    await dropSchema(url, name);
    throw new Error('테스트 스키마 격리 실패: search_path가 실행 스키마가 아닙니다');
  }
  let dropped = false;
  return {
    name,
    pool,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      await dropSchema(url, name);
    },
  };
}

/** 풀에서 연결 하나를 빌려 작업 후 반드시 돌려준다. */
export async function withClient<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}
