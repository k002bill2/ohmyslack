import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { checkLoopbackUrl, redactSecrets, runMigrateCli, type MigrateCliDeps } from '../../bin/lib/migrate-cli.js';
import { pipedIo } from '../auth/bootstrap-harness.js';

/** 운영 마이그레이션 CLI 단위 테스트: URL 검사·출력 형식·비밀값 미출력(DB 없음). */
const USER = 'opsuser_zq7';
const SECRET = 'S3cr3t-pa55-xyz';
const REMOTE = `postgres://${USER}:${SECRET}@db.example.com:5432/ohmyslack`;
const LOCAL = `postgres://${USER}:${SECRET}@127.0.0.1:5432/ohmyslack_x`;

function noLeak(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(USER);
  expect(text).not.toContain('postgres://');
}

/** 연결 시도 자체를 기록하는 가짜 풀. */
function fakeDeps(onConnect: () => Promise<unknown>): { deps: MigrateCliDeps; opened: string[] } {
  const opened: string[] = [];
  const pool = { connect: onConnect, end: async () => undefined, on: () => pool } as unknown as pg.Pool;
  return {
    opened,
    deps: {
      openPool: (url) => {
        opened.push(url);
        return pool;
      },
    },
  };
}

describe('checkLoopbackUrl', () => {
  it.each([
    'postgres://u:p@127.0.0.1:5432/db',
    'postgresql://u:p@localhost/db',
    'postgres://u:p@[::1]:5432/db',
    'postgres://LOCALHOST/db',
  ])('루프백 허용: %s', (url) => {
    expect(checkLoopbackUrl(url)).toEqual({ ok: true });
  });

  it.each([
    ['원격 호스트', REMOTE, 'non_loopback'],
    ['127.0.0.2', 'postgres://u:p@127.0.0.2/db', 'non_loopback'],
    ['localhost 접두 도메인', 'postgres://u:p@localhost.example.com/db', 'non_loopback'],
    ['host 쿼리로 덮기', 'postgres://u:p@127.0.0.1/db?host=db.example.com', 'host_override'],
    ['hostaddr 쿼리로 덮기', 'postgres://u:p@localhost/db?hostaddr=10.0.0.5', 'host_override'],
    ['유닉스 소켓(빈 호스트)', 'postgres:///db?host=/tmp', 'host_override'],
    ['빈 호스트', 'postgres:///db', 'non_loopback'],
    ['다중 호스트', 'postgres://u:p@127.0.0.1,db.example.com/db', 'invalid_url'],
    ['스킴 아님', 'mysql://u:p@127.0.0.1/db', 'invalid_url'],
    ['키=값 형식', 'host=127.0.0.1 dbname=db', 'invalid_url'],
  ])('거부: %s', (_label, url, code) => {
    expect(checkLoopbackUrl(url)).toEqual({ ok: false, code });
  });
});

describe('redactSecrets', () => {
  it('URL 원문·사용자명·비밀번호·postgres URL 패턴을 지운다', () => {
    const text = `connect failed for ${LOCAL} as ${USER} with ${SECRET}; other postgresql://a:b@h/x`;
    const redacted = redactSecrets(text, LOCAL);
    noLeak(redacted);
    expect(redacted).toContain('connect failed');
  });

  it('쿼리 user/password와 pg 인증 오류의 user "<이름>"도 지운다(Codex P2)', () => {
    const url = `postgres://127.0.0.1/db?user=${USER}&password=${SECRET}`;
    expect(checkLoopbackUrl(url)).toEqual({ ok: true });
    noLeak(redactSecrets(`password authentication failed for user "${USER}" (${SECRET})`, url));
    expect(redactSecrets('password authentication failed for user "pguser_env"', 'postgres://127.0.0.1/db')).not.toContain('pguser_env');
  });

  it('URL이 해석되지 않아도 원문은 지운다', () => {
    expect(redactSecrets('x host=1 y', 'host=1')).toBe('x [redacted] y');
  });
});

describe('runMigrateCli 거부 경로(종료 2, DB 접속 없음)', () => {
  it('DATABASE_URL이 없으면 2', async () => {
    const io = pipedIo('');
    const { deps, opened } = fakeDeps(async () => undefined);
    expect(await runMigrateCli([], {}, io, deps)).toBe(2);
    expect(io.err()).toContain('DATABASE_URL');
    expect(io.out()).toBe('');
    expect(opened).toEqual([]);
  });

  it('DATABASE_URL이 빈 문자열이어도 2', async () => {
    const io = pipedIo('');
    expect(await runMigrateCli([], { DATABASE_URL: '' }, io, fakeDeps(async () => undefined).deps)).toBe(2);
  });

  it('루프백이 아니면 접속하지 않고 2, 비밀값 미출력', async () => {
    const io = pipedIo('');
    const { deps, opened } = fakeDeps(async () => undefined);
    expect(await runMigrateCli([], { DATABASE_URL: REMOTE }, io, deps)).toBe(2);
    expect(opened).toEqual([]);
    expect(io.err()).toContain('non_loopback');
    expect(io.err()).not.toContain('db.example.com');
    noLeak(io.err() + io.out());
  });

  it('알 수 없는 인자는 값 되풀이 없이 2', async () => {
    const io = pipedIo('');
    const { deps, opened } = fakeDeps(async () => undefined);
    expect(await runMigrateCli(['--password', SECRET], { DATABASE_URL: LOCAL }, io, deps)).toBe(2);
    expect(opened).toEqual([]);
    noLeak(io.err() + io.out());
  });
});

describe('runMigrateCli 실패 경로(종료 1)', () => {
  it('접속 오류는 MIGRATE FAILED <code>, 메시지의 URL·비밀값 제거', async () => {
    const io = pipedIo('');
    const failure = Object.assign(new Error(`connect ECONNREFUSED ${LOCAL} user=${USER} password=${SECRET}`), {
      code: 'ECONNREFUSED',
    });
    const { deps, opened } = fakeDeps(() => Promise.reject(failure));
    expect(await runMigrateCli([], { DATABASE_URL: LOCAL }, io, deps)).toBe(1);
    expect(opened).toEqual([LOCAL]);
    expect(io.err()).toContain('MIGRATE FAILED ECONNREFUSED');
    expect(io.out()).toBe('');
    noLeak(io.err());
  });

  it('코드가 없는 오류는 MIGRATE FAILED unknown', async () => {
    const io = pipedIo('');
    const { deps } = fakeDeps(() => Promise.reject(new Error('boom')));
    expect(await runMigrateCli(['--dry-run'], { DATABASE_URL: LOCAL }, io, deps)).toBe(1);
    expect(io.err()).toMatch(/^MIGRATE FAILED unknown$/m);
  });
});
