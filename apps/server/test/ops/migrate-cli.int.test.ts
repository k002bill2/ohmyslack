import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDeps, runMigrateCli } from '../../bin/lib/migrate-cli.js';
import { pipedIo, type CapturedIo } from '../auth/bootstrap-harness.js';
import { createTestSchema, type TestSchema } from '../support/test-db.js';

/**
 * 운영 마이그레이션 CLI 통합 테스트(ohmyslack_test). 실행 스키마 t_<runid>는 test-db 하네스가 만들고 지운다.
 * CLI는 DATABASE_URL만 받으므로 test-db의 isolatedConfig와 같은 방식(options의 `-c search_path=<스키마>`)을 URL 쿼리로 넣는다.
 */
const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
const MIGRATION = '0001_initial_schema.sql';

let schema: TestSchema;
let databaseUrl: string;

function schemaUrl(name: string): string {
  const parsed = new URL(process.env.TEST_DATABASE_URL ?? '');
  const existing = parsed.searchParams.get('options');
  parsed.searchParams.delete('options');
  const options = [existing, `-c search_path=${name}`].filter((part) => part !== null && part !== '').join(' ');
  parsed.searchParams.set('options', options);
  return parsed.toString();
}

async function run(argv: readonly string[], migrationsDir?: string): Promise<{ code: number; io: CapturedIo }> {
  const io = pipedIo('');
  const deps = migrationsDir === undefined ? defaultDeps : { ...defaultDeps, migrationsDir };
  const code = await runMigrateCli(argv, { DATABASE_URL: databaseUrl }, io, deps);
  return { code, io };
}

async function ledgerExists(): Promise<boolean> {
  const result = await schema.pool.query<{ reg: string | null }>("SELECT to_regclass('schema_migrations')::text AS reg");
  return result.rows[0]?.reg != null;
}

async function ledgerCount(): Promise<number> {
  const result = await schema.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations');
  return Number(result.rows[0]?.n);
}

function assertNoSecrets(text: string): void {
  const url = new URL(databaseUrl);
  expect(text).not.toContain(databaseUrl);
  if (url.password !== '') expect(text).not.toContain(url.password);
  if (url.username !== '') expect(text).not.toContain(url.username);
  expect(text).not.toMatch(/postgres(ql)?:\/\//);
}

beforeEach(async () => {
  schema = await createTestSchema();
  databaseUrl = schemaUrl(schema.name);
});

afterEach(async () => {
  await schema.drop();
});

describe('migrate CLI (실DB, 격리 스키마)', () => {
  it('dry-run은 적용 예정 목록만 내고 DB에 쓰지 않는다(schema_migrations도 만들지 않음)', async () => {
    const { code, io } = await run(['--dry-run']);
    expect(code).toBe(0);
    expect(io.out()).toBe(`${MIGRATION}\nMIGRATE DRY-RUN pending=1 total=0\n`);
    expect(await ledgerExists()).toBe(false);
    const tables = await schema.pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1', [schema.name]);
    expect(tables.rowCount).toBe(0);
    assertNoSecrets(io.out() + io.err());
  });

  it('적용 → 새 파일 이름과 MIGRATE OK applied=1 total=1, 재실행은 applied=0(멱등)', async () => {
    const first = await run([]);
    expect(first.code).toBe(0);
    expect(first.io.out()).toBe(`${MIGRATION}\nMIGRATE OK applied=1 total=1\n`);
    expect(await ledgerCount()).toBe(1);
    const users = await schema.pool.query("SELECT to_regclass('users')::text AS reg");
    expect(users.rows[0]).toEqual({ reg: 'users' });

    const second = await run([]);
    expect(second.code).toBe(0);
    expect(second.io.out()).toBe('MIGRATE OK applied=0 total=1\n');
    expect(await ledgerCount()).toBe(1);

    const dry = await run(['--dry-run']);
    expect(dry.io.out()).toBe('MIGRATE DRY-RUN pending=0 total=1\n');
    assertNoSecrets(first.io.out() + first.io.err() + second.io.out() + second.io.err() + dry.io.out());
  });

  it('적용 기록 sha256이 다르면 적용·dry-run 모두 MIGRATE FAILED migration_error, 종료 1', async () => {
    expect((await run([])).code).toBe(0);
    await schema.pool.query("UPDATE schema_migrations SET sha256 = 'tampered'");
    for (const argv of [[], ['--dry-run']]) {
      const { code, io } = await run(argv);
      expect(code).toBe(1);
      expect(io.out()).toBe('');
      expect(io.err()).toMatch(/^MIGRATE FAILED migration_error$/m);
      assertNoSecrets(io.err());
    }
  });

  it('적용된 파일보다 앞선 미적용 파일이 생기면 dry-run도 실제 적용과 같이 migration_error(Codex P2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-cli-'));
    try {
      await writeFile(join(dir, '0002_later.sql'), 'CREATE TABLE later_t (id int)');
      expect((await run([], dir)).code).toBe(0);
      await writeFile(join(dir, '0001_earlier.sql'), 'CREATE TABLE earlier_t (id int)');
      for (const argv of [['--dry-run'], []]) {
        const { code, io } = await run(argv, dir);
        expect(code).toBe(1);
        expect(io.out()).toBe('');
        expect(io.err()).toContain('0001_earlier.sql');
        expect(io.err()).toMatch(/^MIGRATE FAILED migration_error$/m);
      }
      expect(await ledgerCount()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bin/migrate.ts 프로세스: dry-run 종료 0, 원격 호스트는 종료 2', { timeout: 30_000 }, async () => {
    const exec = promisify(execFile);
    const ok = await exec(TSX, ['bin/migrate.ts', '--dry-run'], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: databaseUrl } });
    expect(ok.stdout.trim().split('\n').at(-1)).toBe('MIGRATE DRY-RUN pending=1 total=0');
    expect(await ledgerExists()).toBe(false);

    const remote = new URL(databaseUrl);
    remote.hostname = 'db.example.com';
    const refused = await exec(TSX, ['bin/migrate.ts'], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: remote.toString() } }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('non_loopback');
    assertNoSecrets(ok.stdout + ok.stderr + refused.stderr);
  });
});
