import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.js';
import { createTestSchema, withClient, type TestSchema } from '../support/test-db.js';

/** 0002_bots(TRD §2 `users`·`bot_tokens`, §5-2): 0001만 적용된 DB에 기존 행을 두고 0002를 얹는다. */
const FIRST = '0001_initial_schema.sql';
const SECOND = '0002_bots.sql';

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function expectState(work: Promise<unknown>, state: string): Promise<void> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(sqlState(error)).toBe(state);
}

const INSERT_USER = 'INSERT INTO users (id, email_norm, display_name, password_hash, status, kind) VALUES ($1, $2, $3, $4, $5, $6)';

describe('0002_bots 마이그레이션', () => {
  let schema: TestSchema | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await schema?.drop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    schema = undefined;
    dir = undefined;
  });

  async function upgradedWithLegacyUsers(): Promise<{ schema: TestSchema; legacy: readonly string[] }> {
    schema = await createTestSchema();
    dir = await mkdtemp(join(tmpdir(), 'ohmyslack-0002-'));
    await copyFile(join(MIGRATIONS_DIR, FIRST), join(dir, FIRST));
    const migrationsDir = dir;
    const legacy = [randomUUID(), randomUUID()];
    await withClient(schema.pool, async (client) => {
      expect((await migrate(client, migrationsDir)).applied).toEqual([FIRST]);
      for (const [i, id] of legacy.entries()) {
        await client.query(
          "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, $2, 'Legacy', 'phc-fixture', $3)",
          [id, `legacy${i}@example.test`, i === 0 ? 'active' : 'disabled'],
        );
      }
      await copyFile(join(MIGRATIONS_DIR, SECOND), join(migrationsDir, SECOND));
      expect((await migrate(client, migrationsDir)).applied).toEqual([SECOND]);
    });
    return { schema, legacy };
  }

  it('기존 사용자는 모두 kind=human으로 남고 해시가 보존되며 CHECK 위반 행이 0개다', async () => {
    const { schema: s, legacy } = await upgradedWithLegacyUsers();
    const rows = await s.pool.query<{ id: string; kind: string; password_hash: string | null }>(
      'SELECT id, kind, password_hash FROM users ORDER BY email_norm',
    );
    expect(rows.rows.map((r) => r.id)).toEqual(legacy);
    expect(rows.rows.every((r) => r.kind === 'human' && r.password_hash === 'phc-fixture')).toBe(true);
    const violations = await s.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM users WHERE NOT ((kind = 'human') = (password_hash IS NOT NULL)) OR kind NOT IN ('human','bot')",
    );
    expect(violations.rows[0]?.n).toBe('0');
  });

  it('human에 password_hash NULL, bot에 해시, 알 수 없는 kind 삽입은 CHECK(23514)로 거부된다', async () => {
    const { schema: s } = await upgradedWithLegacyUsers();
    await expectState(s.pool.query(INSERT_USER, [randomUUID(), 'h@example.test', 'H', null, 'active', 'human']), '23514');
    await expectState(s.pool.query(INSERT_USER, [randomUUID(), 'b@bot.invalid', 'B', 'phc-fixture', 'active', 'bot']), '23514');
    await expectState(s.pool.query(INSERT_USER, [randomUUID(), 'r@example.test', 'R', null, 'active', 'robot']), '23514');
    await s.pool.query(INSERT_USER, [randomUUID(), 'ok@bot.invalid', 'OK', null, 'active', 'bot']);
  });

  it('bot_tokens: token_hash UNIQUE, 봇 삭제 시 CASCADE, 미폐기 부분 인덱스가 있다', async () => {
    const { schema: s } = await upgradedWithLegacyUsers();
    const botId = randomUUID();
    await s.pool.query(INSERT_USER, [botId, 'jarvis@bot.invalid', 'Jarvis', null, 'active', 'bot']);
    const insert = 'INSERT INTO bot_tokens (id, bot_user_id, token_hash, label, created_at) VALUES ($1, $2, $3, $4, now())';
    await s.pool.query(insert, [randomUUID(), botId, 'hash-fixture-1', 'adapter']);
    await expectState(s.pool.query(insert, [randomUUID(), botId, 'hash-fixture-1', 'dup']), '23505');
    await s.pool.query('DELETE FROM users WHERE id = $1', [botId]);
    const left = await s.pool.query('SELECT 1 FROM bot_tokens');
    expect(left.rowCount).toBe(0);
    const idx = await s.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'bot_tokens' AND indexname = 'bot_tokens_live_idx'",
      [s.name],
    );
    expect(idx.rows[0]?.indexdef).toMatch(/\(bot_user_id\) WHERE \(revoked_at IS NULL\)$/);
  });
});
