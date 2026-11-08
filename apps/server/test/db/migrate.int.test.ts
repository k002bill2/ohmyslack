import { cp, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.js';
import { createTestSchema, withClient, type TestSchema } from '../support/test-db.js';

// 0003_attachments(W-21)로 attachment_blobs·attachments 2개 추가(이름 정렬 순). 0004_push(W-23)로 push_subscriptions 추가.
const TRD_TABLES = [
  'attachment_blobs',
  'attachments',
  'bot_tokens',
  'conversation_changes',
  'conversation_members',
  'conversation_read_state',
  'conversations',
  'invites',
  'message_mentions',
  'messages',
  'push_subscriptions',
  'sessions',
  'sync_clock',
  'thread_read_state',
  'thread_unread_targets',
  'users',
  'workspace_members',
  'workspaces',
];

/** TRD §2 필수 인덱스 6개: 테이블과 키 컬럼(방향 포함) 순서. */
const REQUIRED_INDEXES: readonly (readonly [string, string])[] = [
  ['messages', 'conversation_id, seq DESC'],
  ['messages', 'conversation_id, thread_root_id, seq'],
  ['conversation_changes', 'change_id'],
  ['conversation_changes', 'conversation_id, change_id'],
  ['conversation_members', 'user_id, conversation_id'],
  ['message_mentions', 'user_id, message_id'],
];

describe('db migrate', () => {
  const schemas: TestSchema[] = [];
  const tempDirs: string[] = [];

  async function freshSchema(): Promise<TestSchema> {
    const schema = await createTestSchema();
    schemas.push(schema);
    return schema;
  }

  afterEach(async () => {
    await Promise.all(schemas.splice(0).map((schema) => schema.drop()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('applies all migrations (0001, 0002) to an empty schema and creates all 15 TRD tables', async () => {
    const { pool, name } = await freshSchema();
    const result = await withClient(pool, (client) => migrate(client, MIGRATIONS_DIR));
    // 0002_bots 추가(W-18)로 목록 고정 대신 포함·순서 단언.
    expect(result.applied).toEqual(expect.arrayContaining(['0001_initial_schema.sql', '0002_bots.sql']));
    expect(result.applied.indexOf('0001_initial_schema.sql')).toBeLessThan(result.applied.indexOf('0002_bots.sql'));
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'schema_migrations' ORDER BY table_name`,
      [name],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(TRD_TABLES);
    const clock = await pool.query('SELECT id, last_change_id FROM sync_clock');
    expect(clock.rows).toEqual([{ id: 1, last_change_id: '0' }]);
  });

  it('creates the 6 required TRD indexes', async () => {
    const { pool, name } = await freshSchema();
    await withClient(pool, (client) => migrate(client));
    const defs = await pool.query<{ tablename: string; indexdef: string }>(
      'SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = $1',
      [name],
    );
    for (const [table, columns] of REQUIRED_INDEXES) {
      const found = defs.rows.some((row) => row.tablename === table && row.indexdef.endsWith(`btree (${columns})`));
      expect(found, `${table}(${columns})`).toBe(true);
    }
  });

  it('applies nothing on rerun and records name, applied_at and sha256', async () => {
    const { pool } = await freshSchema();
    const client = await pool.connect();
    try {
      await migrate(client);
      const rerun = await migrate(client);
      expect(rerun.applied).toEqual([]);
      expect(rerun.skipped).toEqual(expect.arrayContaining(['0001_initial_schema.sql', '0002_bots.sql']));
      const ledger = await client.query('SELECT name, applied_at, sha256 FROM schema_migrations');
      expect(ledger.rows).toHaveLength(rerun.skipped.length);
      expect(ledger.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      client.release();
    }
  });

  it('keeps the run schema as search_path even when the URL carries an options parameter', async () => {
    const original = process.env.TEST_DATABASE_URL ?? '';
    const withOptions = new URL(original);
    withOptions.searchParams.set('options', '-c search_path=public');
    process.env.TEST_DATABASE_URL = withOptions.toString();
    try {
      const { pool, name } = await freshSchema();
      const current = await pool.query<{ schema: string }>('SELECT current_schema() AS schema');
      expect(current.rows[0]?.schema).toBe(name);
    } finally {
      process.env.TEST_DATABASE_URL = original;
    }
  });

  it('fails when an already-applied migration file is modified', async () => {
    const { pool } = await freshSchema();
    const dir = await mkdtemp(join(tmpdir(), 'ohmyslack-migrations-'));
    tempDirs.push(dir);
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const client = await pool.connect();
    try {
      await migrate(client, dir);
      await appendFile(join(dir, '0001_initial_schema.sql'), '\n-- tampered\n');
      await expect(migrate(client, dir)).rejects.toThrow(/내용이 바뀌었습니다: 0001_initial_schema\.sql/);
    } finally {
      client.release();
    }
  });
});
