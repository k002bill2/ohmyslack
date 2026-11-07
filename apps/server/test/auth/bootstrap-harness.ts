import { Readable, Writable } from 'node:stream';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createTestSchema, withClient, type TestSchema } from '../support/test-db.js';
import type { CliIo } from '../../bin/lib/cli.js';

/** bootstrap·reset-password 통합 테스트 공통: 마이그레이션된 실행 스키마 + 캡처되는 CLI 입출력. */
export interface CapturedIo extends CliIo {
  out(): string;
  err(): string;
}

function sink(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  });
}

/** stdin 파이프(비 TTY) 입력을 흉내 낸다. */
export function pipedIo(stdinText: string): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: Readable.from([stdinText]),
    stdout: sink(out),
    stderr: sink(err),
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

export async function migratedSchema(): Promise<TestSchema> {
  const schema = await createTestSchema();
  await withClient(schema.pool, (client) => migrate(client));
  return schema;
}

/** 실행 스키마의 사용자 테이블 전 행을 텍스트로 덤프한다(카나리아 전수 검사용). */
export async function dumpAllRows(pool: pg.Pool): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const parts: string[] = [];
  for (const { table_name: table } of tables.rows) {
    const rows = await pool.query<{ row: string }>(`SELECT t::text AS row FROM "${table}" t`);
    parts.push(...rows.rows.map((r) => `${table}:${r.row}`));
  }
  return parts.join('\n');
}

export interface AccountSnapshot {
  readonly workspaces: readonly unknown[];
  readonly users: readonly unknown[];
  readonly members: readonly unknown[];
}

export async function snapshot(pool: pg.Pool): Promise<AccountSnapshot> {
  const [workspaces, users, members] = await Promise.all([
    pool.query('SELECT * FROM workspaces ORDER BY id'),
    pool.query('SELECT * FROM users ORDER BY id'),
    pool.query('SELECT * FROM workspace_members ORDER BY workspace_id, user_id'),
  ]);
  return { workspaces: workspaces.rows, users: users.rows, members: members.rows };
}

/** tools/log-canaries.ts 값을 string으로 꺼낸다(없으면 테스트 설정 오류). */
export function canary(kind: string): string {
  const value = LOG_CANARIES[kind];
  if (value === undefined) throw new Error(`카나리아 없음: ${kind}`);
  return value;
}
