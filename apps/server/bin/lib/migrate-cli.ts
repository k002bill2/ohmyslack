import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import pg from 'pg';
import { loadMigrations, migrate, MIGRATIONS_DIR, MigrationError } from '../../src/db/migrate.js';

/**
 * 운영 마이그레이션 CLI 로직(런북: docs/runbooks/BOOTSTRAP_OWNER.md §0).
 * DATABASE_URL만 읽고, 루프백 호스트만 허용한다. 접속 문자열·사용자명·비밀번호는 어느 스트림에도 쓰지 않는다.
 */
export interface MigrateCliIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface MigrateCliDeps {
  readonly openPool: (url: string) => pg.Pool;
  readonly migrationsDir?: string;
}

export type UrlCheck = { readonly ok: true } | { readonly ok: false; readonly code: 'invalid_url' | 'non_loopback' | 'host_override' };

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);
const HOST_OVERRIDES = ['host', 'hostaddr'] as const;
const USAGE = '사용법: migrate [--dry-run] (접속은 환경변수 DATABASE_URL만)';
const REDACTED = '[redacted]';

const defaultDeps: MigrateCliDeps = {
  openPool: (url) => new pg.Pool({ connectionString: url, max: 1 }),
};

/** 루프백(127.0.0.1·localhost·::1)만 허용. 쿼리의 host/hostaddr는 URL 호스트를 덮을 수 있어 거부한다. */
export function checkLoopbackUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url' };
  }
  if (!PROTOCOLS.has(url.protocol)) return { ok: false, code: 'invalid_url' };
  if (HOST_OVERRIDES.some((key) => url.searchParams.has(key))) return { ok: false, code: 'host_override' };
  const host = url.hostname.toLowerCase();
  if (host.includes(',')) return { ok: false, code: 'invalid_url' };
  return LOOPBACK_HOSTS.has(host) ? { ok: true } : { ok: false, code: 'non_loopback' };
}

function credentials(raw: string): readonly string[] {
  try {
    const url = new URL(raw);
    return [url.password, url.username, decodeURIComponent(url.password), decodeURIComponent(url.username)];
  } catch {
    return [];
  }
}

/** 오류 문구에서 접속 문자열 원문·사용자명·비밀번호·postgres URL 패턴을 지운다. */
export function redactSecrets(text: string, rawUrl: string): string {
  const needles = [rawUrl, ...credentials(rawUrl)].filter((part) => part !== '').sort((a, b) => b.length - a.length);
  const stripped = needles.reduce((acc, needle) => acc.split(needle).join(REDACTED), text);
  return stripped.replace(/postgres(?:ql)?:\/\/\S+/gi, REDACTED);
}

function errorCode(error: unknown): string {
  if (error instanceof MigrationError) return 'migration_error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'unknown';
}

function parseDryRun(argv: readonly string[]): boolean | undefined {
  try {
    const { values } = parseArgs({ args: [...argv], options: { 'dry-run': { type: 'boolean' } }, strict: true, allowPositionals: false });
    return values['dry-run'] === true;
  } catch {
    return undefined;
  }
}

interface LedgerRow {
  readonly name: string;
  readonly sha256: string;
}

/** 읽기 전용 트랜잭션에서 schema_migrations만 조회해 적용 예정 파일을 구한다(DB 쓰기 없음). */
async function pendingFiles(client: pg.ClientBase, dir: string): Promise<{ pending: readonly string[]; total: number }> {
  const files = await loadMigrations(dir);
  await client.query('BEGIN READ ONLY');
  try {
    const exists = await client.query<{ reg: string | null }>("SELECT to_regclass('schema_migrations')::text AS reg");
    const rows =
      exists.rows[0]?.reg == null
        ? []
        : (await client.query<LedgerRow>('SELECT name, sha256 FROM schema_migrations ORDER BY name')).rows;
    const byName = new Map(files.map((file) => [file.name, file.sha256]));
    for (const row of rows) {
      const sha = byName.get(row.name);
      if (sha === undefined) throw new MigrationError(`적용 기록이 있는 파일이 없습니다: ${row.name}`);
      if (sha !== row.sha256) throw new MigrationError(`적용된 마이그레이션 내용이 바뀌었습니다: ${row.name}`);
    }
    const applied = new Set(rows.map((row) => row.name));
    return { pending: files.filter((file) => !applied.has(file.name)).map((file) => file.name), total: rows.length };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function execute(pool: pg.Pool, dryRun: boolean, dir: string, io: MigrateCliIo): Promise<void> {
  const client = await pool.connect();
  try {
    if (dryRun) {
      const { pending, total } = await pendingFiles(client, dir);
      for (const name of pending) io.stdout.write(`${name}\n`);
      io.stdout.write(`MIGRATE DRY-RUN pending=${pending.length} total=${total}\n`);
      return;
    }
    const result = await migrate(client, dir);
    for (const name of result.applied) io.stdout.write(`${name}\n`);
    io.stdout.write(`MIGRATE OK applied=${result.applied.length} total=${result.applied.length + result.skipped.length}\n`);
  } finally {
    client.release();
  }
}

/** CLI 진입. 반환값은 종료 코드(0 성공·1 실패·2 사용법/설정 거부). */
export async function runMigrateCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: MigrateCliIo,
  deps: MigrateCliDeps = defaultDeps,
): Promise<number> {
  const dryRun = parseDryRun(argv);
  if (dryRun === undefined) {
    io.stderr.write(`migrate 실패(usage): ${USAGE}. 변경 없음.\n`);
    return EXIT_USAGE;
  }
  const url = env.DATABASE_URL;
  if (url === undefined || url === '') {
    io.stderr.write('migrate 실패(config): DATABASE_URL이 설정되지 않았습니다. 변경 없음.\n');
    return EXIT_USAGE;
  }
  const check = checkLoopbackUrl(url);
  if (!check.ok) {
    io.stderr.write(`migrate 실패(${check.code}): 루프백 호스트(127.0.0.1·localhost·::1)의 postgres URL만 허용합니다. 변경 없음.\n`);
    return EXIT_USAGE;
  }
  const pool = deps.openPool(url);
  pool.on('error', () => undefined);
  try {
    await execute(pool, dryRun, deps.migrationsDir ?? MIGRATIONS_DIR, io);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message !== '') io.stderr.write(`migrate 오류: ${redactSecrets(message, url)}\n`);
    io.stderr.write(`MIGRATE FAILED ${errorCode(error)}\n`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
