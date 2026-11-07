import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_CANARIES } from '../../../../tools/log-canaries.js';
import { runBootstrapOwner } from '../../bin/lib/bootstrap.js';
import { verifyPassword } from '../../src/modules/auth/password.js';
import { buildApp } from '../../src/app.js';
import type { TestSchema } from '../support/test-db.js';
import { canary, dumpAllRows, migratedSchema, pipedIo, snapshot } from './bootstrap-harness.js';

/** 정본: DEV_DESIGN 6-2 BOOT-01, TRD §5. 초대 발급·member 수락 단언은 W-06(invite 라우트)에서 이 파일에 추가한다. */
const PASSWORD = canary('credential');
const EMAIL = '  Owner@Example.TEST ';
const FIRST = ['--email', EMAIL, '--name', 'Owner', '--workspace', 'Home'];
const SECOND = ['--email', 'intruder@example.test', '--name', 'Intruder', '--workspace', 'Other'];

let schema: TestSchema;

beforeEach(async () => {
  schema = await migratedSchema();
});

afterEach(async () => {
  await schema.drop();
});

function counts(): Promise<{ users: number; owners: number; workspaces: number }> {
  return schema.pool
    .query<{ users: number; owners: number; workspaces: number }>(
      `SELECT (SELECT count(*)::int FROM users) AS users,
              (SELECT count(*)::int FROM workspace_members WHERE role = 'owner') AS owners,
              (SELECT count(*)::int FROM workspaces) AS workspaces`,
    )
    .then((r) => r.rows[0] ?? { users: -1, owners: -1, workspaces: -1 });
}

describe('BOOT-01 최초 owner 생성 (bin/bootstrap-owner.ts)', () => {
  it('BOOT-01 빈 합성 DB에서 owner 최초 생성은 성공하고 재실행은 기존 계정을 바꾸지 않고 실패하며 owner를 만드는 원격 라우트가 없고 이후 초대 발급과 member 수락이 된다', async () => {
    const first = pipedIo(`${PASSWORD}\n`);
    expect(await runBootstrapOwner(FIRST, first, schema.pool)).toBe(0);
    expect(await counts()).toEqual({ users: 1, owners: 1, workspaces: 1 });
    const user = await schema.pool.query<{ email_norm: string; status: string; password_hash: string }>(
      'SELECT email_norm, status, password_hash FROM users',
    );
    expect(user.rows[0]?.email_norm).toBe('owner@example.test');
    expect(user.rows[0]?.status).toBe('active');
    expect(await verifyPassword(PASSWORD, user.rows[0]?.password_hash ?? '')).toBe(true);

    const before = await snapshot(schema.pool);
    const rerun = pipedIo('another-password-123\n');
    expect(await runBootstrapOwner(SECOND, rerun, schema.pool)).toBe(1);
    expect(rerun.err()).toContain('owner_exists');
    expect(await snapshot(schema.pool)).toEqual(before);
    expect(await counts()).toEqual({ users: 1, owners: 1, workspaces: 1 });

    const app = buildApp();
    await app.ready();
    expect(app.printRoutes()).not.toMatch(/owner|bootstrap|signup|register/i);
    for (const url of ['/api/bootstrap', '/api/owner', '/api/auth/signup', '/api/auth/register']) {
      const res = await app.inject({ method: 'POST', url, payload: { email: 'x@example.test', password: PASSWORD } });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
    expect(await counts()).toEqual({ users: 1, owners: 1, workspaces: 1 });
  });

  it('비밀번호 원문은 DB 전 테이블·stdout·stderr 어디에도 남지 않는다', async () => {
    const io = pipedIo(`${PASSWORD}\r\n`);
    expect(await runBootstrapOwner(FIRST, io, schema.pool)).toBe(0);
    const rerun = pipedIo(`${PASSWORD}\n`);
    expect(await runBootstrapOwner(SECOND, rerun, schema.pool)).toBe(1);
    const dump = await dumpAllRows(schema.pool);
    expect(dump).toContain('users:');
    expect(dump.includes(PASSWORD)).toBe(false);
    for (const text of [io.out(), io.err(), rerun.out(), rerun.err()]) {
      for (const canary of Object.values(LOG_CANARIES)) expect(text.includes(canary)).toBe(false);
      expect(text).not.toMatch(/\$argon2id\$|owner@example/i);
    }
  });

  it('정책 위반 비밀번호(11 code point)는 거부되고 어떤 행도 만들지 않는다', async () => {
    const io = pipedIo('🔐'.repeat(11));
    expect(await runBootstrapOwner(FIRST, io, schema.pool)).toBe(1);
    expect(io.err()).toContain('policy_too_short');
    expect(await counts()).toEqual({ users: 0, owners: 0, workspaces: 0 });
  });

  it('argv로 비밀번호를 넘기면 사용법 오류로 거부하고 그 값을 출력하지 않는다', async () => {
    const io = pipedIo(`${PASSWORD}\n`);
    const argv = [...FIRST, '--password', canary('token')];
    expect(await runBootstrapOwner(argv, io, schema.pool)).toBe(2);
    expect(`${io.out()}${io.err()}`.includes(canary('token'))).toBe(false);
    expect(await counts()).toEqual({ users: 0, owners: 0, workspaces: 0 });
  });

  it('워크스페이스가 없는데 이름이 없으면 거부한다', async () => {
    const io = pipedIo(`${PASSWORD}\n`);
    expect(await runBootstrapOwner(['--email', EMAIL, '--name', 'Owner'], io, schema.pool)).toBe(1);
    expect(io.err()).toContain('workspace_name_required');
    expect(await counts()).toEqual({ users: 0, owners: 0, workspaces: 0 });
  });
});
