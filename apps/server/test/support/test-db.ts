import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { checkTestDbUrl } from '../../../../tools/assert-test-db.js';

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

/** 빈 실행 스키마를 만들고 search_path를 그 스키마로 둔 풀을 돌려준다(마이그레이션은 호출자가 적용). */
export async function createTestSchema(): Promise<TestSchema> {
  const url = testDatabaseUrl();
  const name = newSchemaName();
  await withAdmin(url, (client) => client.query(`CREATE SCHEMA "${name}"`));
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${name}`, max: 4 });
  let dropped = false;
  return {
    name,
    pool,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      await withAdmin(url, (client) => client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
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
