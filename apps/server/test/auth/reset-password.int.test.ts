import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { runBootstrapOwner } from '../../bin/lib/bootstrap.js';
import { runResetPassword } from '../../bin/lib/reset-password.js';
import { verifyPassword } from '../../src/modules/auth/password.js';
import type { TestSchema } from '../support/test-db.js';
import { canary, dumpAllRows, migratedSchema, pipedIo } from './bootstrap-harness.js';

/** 정본: TRD §5-1 S4. WS 5초 내 close는 W-09 범위 — 여기서는 훅 호출까지만 단언한다. */
const OLD = 'old-password-0001';
const NEW = canary('credential');
const OWNER_EMAIL = 'owner@example.test';

let schema: TestSchema;
let ownerId: string;
let otherId: string;

async function insertSession(userId: string, revokedAt: string | null = null): Promise<void> {
  await schema.pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, now(), now(), now() + interval '30 days', $4)`,
    [randomUUID(), userId, randomUUID(), revokedAt],
  );
}

beforeEach(async () => {
  schema = await migratedSchema();
  const io = pipedIo(`${OLD}\n`);
  expect(await runBootstrapOwner(['--email', OWNER_EMAIL, '--name', 'Owner', '--workspace', 'Home'], io, schema.pool)).toBe(0);
  ownerId = (await schema.pool.query<{ id: string }>('SELECT id FROM users')).rows[0]?.id ?? '';
  otherId = randomUUID();
  await schema.pool.query(
    "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, 'other@example.test', 'Other', 'x', 'active')",
    [otherId],
  );
  await insertSession(ownerId);
  await insertSession(ownerId);
  await insertSession(ownerId, '2026-11-01T00:00:00Z');
  await insertSession(otherId);
});

afterEach(async () => {
  await schema.drop();
});

async function state(): Promise<{ hash: string; open: Record<string, number> }> {
  const hash = await schema.pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [ownerId]);
  const open = await schema.pool.query<{ user_id: string; n: number }>(
    'SELECT user_id, count(*)::int AS n FROM sessions WHERE revoked_at IS NULL GROUP BY user_id',
  );
  return {
    hash: hash.rows[0]?.password_hash ?? '',
    open: Object.fromEntries(open.rows.map((r) => [r.user_id === ownerId ? 'owner' : 'other', r.n])),
  };
}

describe('reset-password (TRD §5-1 S4)', () => {
  it('성공하면 그 계정의 세션이 전부 revoke되고 새 비밀번호만 검증되며 훅이 COMMIT 뒤 호출된다', async () => {
    const calls: Array<[string, number]> = [];
    const io = pipedIo(`${NEW}\n`);
    const code = await runResetPassword(['--email', ' OWNER@example.test'], io, schema.pool, {
      onSessionsRevoked: async (userId, count) => {
        const seen = await state();
        expect(seen.open.owner).toBeUndefined();
        calls.push([userId, count]);
      },
    });
    expect(code).toBe(0);
    const after = await state();
    expect(after.open).toEqual({ other: 1 });
    expect(await verifyPassword(NEW, after.hash)).toBe(true);
    expect(await verifyPassword(OLD, after.hash)).toBe(false);
    expect(calls).toEqual([[ownerId, 2]]);
    const revokedTimes = await schema.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at = '2026-11-01T00:00:00Z'",
      [ownerId],
    );
    expect(revokedTimes.rows[0]?.n).toBe(1);
    expect((await dumpAllRows(schema.pool)).includes(NEW)).toBe(false);
    for (const text of [io.out(), io.err()]) {
      for (const canary of Object.values(LOG_CANARIES)) expect(text.includes(canary)).toBe(false);
    }
  });

  it('없는 이메일은 실패하고 해시·세션을 바꾸지 않으며 훅을 부르지 않는다', async () => {
    const before = await state();
    let called = false;
    const io = pipedIo(`${NEW}\n`);
    const code = await runResetPassword(['--email', 'nobody@example.test'], io, schema.pool, {
      onSessionsRevoked: () => {
        called = true;
      },
    });
    expect(code).toBe(1);
    expect(io.err()).toContain('no_such_user');
    expect(await state()).toEqual(before);
    expect(called).toBe(false);
  });

  it('정책 위반 새 비밀번호는 거부되고 아무것도 바꾸지 않는다', async () => {
    const before = await state();
    const io = pipedIo('a'.repeat(129));
    expect(await runResetPassword(['--email', OWNER_EMAIL], io, schema.pool)).toBe(1);
    expect(io.err()).toContain('policy_too_long');
    expect(await state()).toEqual(before);
  });
});
