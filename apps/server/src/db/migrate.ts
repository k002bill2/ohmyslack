import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** 순서형 SQL 마이그레이션 위치(정본: DEV_DESIGN §2-1 `apps/server/migrations/NNNN_<설명>.sql`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface AppliedRow {
  readonly name: string;
  readonly sha256: string;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 디렉터리의 *.sql을 이름순으로 읽는다. 형식이 틀리거나 번호가 겹치면 실패한다. */
export async function loadMigrations(dir: string): Promise<readonly MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (match === null) throw new MigrationError(`마이그레이션 파일 이름 형식 위반: ${name} (NNNN_<설명>.sql)`);
    const number = match[1] ?? '';
    if (seen.has(number)) throw new MigrationError(`마이그레이션 번호 중복: ${number}`);
    seen.add(number);
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({ name, sql, sha256: sha256(sql) });
  }
  return files;
}

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL,
  sha256 text NOT NULL
)`;

/** 이미 적용된 기록이 현재 파일과 일치하는지 확인한다(내용 변조·파일 삭제·순서 역전은 실패). */
function assertLedgerMatches(files: readonly MigrationFile[], applied: readonly AppliedRow[]): void {
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const row of applied) {
    const file = byName.get(row.name);
    if (file === undefined) throw new MigrationError(`적용 기록이 있는 파일이 없습니다: ${row.name}`);
    if (file.sha256 !== row.sha256) throw new MigrationError(`적용된 마이그레이션 내용이 바뀌었습니다: ${row.name}`);
  }
  const appliedNames = new Set(applied.map((row) => row.name));
  const lastApplied = [...appliedNames].sort().at(-1);
  const lateFile = files.find((file) => !appliedNames.has(file.name) && lastApplied !== undefined && file.name < lastApplied);
  if (lateFile !== undefined) {
    throw new MigrationError(`이미 적용된 마이그레이션보다 앞선 미적용 파일: ${lateFile.name}`);
  }
}

async function applyOne(client: pg.ClientBase, file: MigrationFile): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query<AppliedRow>('SELECT name, sha256 FROM schema_migrations WHERE name = $1', [file.name]);
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.sha256 !== file.sha256) throw new MigrationError(`적용된 마이그레이션 내용이 바뀌었습니다: ${file.name}`);
      await client.query('COMMIT');
      return false;
    }
    await client.query(file.sql);
    await client.query('INSERT INTO schema_migrations (name, applied_at, sha256) VALUES ($1, now(), $2)', [
      file.name,
      file.sha256,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * 현재 search_path의 첫 스키마에 미적용 마이그레이션을 이름순으로 적용한다.
 * 파일 1개 = 트랜잭션 1개. 적용 기록은 schema_migrations(name, applied_at, sha256).
 */
export async function migrate(client: pg.ClientBase, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = await loadMigrations(dir);
  await client.query(CREATE_LEDGER);
  const ledger = await client.query<AppliedRow>('SELECT name, sha256 FROM schema_migrations ORDER BY name');
  assertLedgerMatches(files, ledger.rows);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (await applyOne(client, file)) applied.push(file.name);
    else skipped.push(file.name);
  }
  return { applied, skipped };
}
