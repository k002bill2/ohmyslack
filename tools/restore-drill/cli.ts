/** `tools/restore-drill.sh`가 부르는 보조 명령. 비밀값은 env 파일(600)에만 쓰고 출력하지 않는다. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkTestDbUrl } from '../assert-test-db.ts';
import type { RunContext } from '../lib/cli.ts';
import { compareSnapshots, parseSnapshot } from './compare.ts';
import { dropSql, readMigrations, renameSql, RESIDUE_SQL, seedSql, snapshotSql } from './sql.ts';

/** Jarvis 결정 1: 복원 대상은 이 DB 안의 격리 스키마뿐. */
export const DRILL_DB = 'ohmyslack_test';
/** 컨테이너 안에서 본 PostgreSQL 주소(컨테이너 내부 포트). */
const CONTAINER_PG = { host: '127.0.0.1', port: '5432' } as const;

export interface DrillTarget {
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** TEST_DATABASE_URL을 검사해 드릴 접속 정보를 만든다. 실패 사유에 URL 원문·비밀값을 넣지 않는다. */
export function drillTarget(raw: string | undefined): DrillTarget {
  const check = checkTestDbUrl(raw);
  if (!check.ok || raw === undefined) throw new Error(`대상 DB 거부: ${check.reason}`);
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== DRILL_DB) throw new Error(`대상 DB 거부: 승인된 대상은 ${DRILL_DB}뿐입니다`);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user === '' || /[\r\n]/.test(user + password)) throw new Error('대상 DB 거부: 사용자 이름이 없거나 값에 줄바꿈이 있습니다');
  return { user, password, database };
}

/** `docker exec --env-file`용 본문. */
export function envFileBody(t: DrillTarget): string {
  return [
    `PGHOST=${CONTAINER_PG.host}`,
    `PGPORT=${CONTAINER_PG.port}`,
    `PGUSER=${t.user}`,
    `PGPASSWORD=${t.password}`,
    `PGDATABASE=${t.database}`,
    'PGOPTIONS=-c client_min_messages=warning',
    '',
  ].join('\n');
}

const USAGE = '사용법: restore-drill <check-url|env-file PATH|seed-sql S|snapshot-sql S|rename-sql A B|drop-sql S...|residue-sql|compare ORIG RESTORED>';

function need(args: readonly string[], n: number): readonly string[] {
  if (args.length < n) throw new Error(USAGE);
  return args;
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  const [cmd, ...args] = argv;
  const root = resolve(ctx.cwd);
  try {
    switch (cmd) {
      case 'check-url': {
        const t = drillTarget(ctx.env.TEST_DATABASE_URL);
        ctx.out(`드릴 대상: ${t.database} (컨테이너 내부 ${CONTAINER_PG.host}:${CONTAINER_PG.port})`);
        return 0;
      }
      case 'env-file': {
        const [path = ''] = need(args, 1);
        writeFileSync(path, envFileBody(drillTarget(ctx.env.TEST_DATABASE_URL)), { mode: 0o600, flag: 'wx' });
        return 0;
      }
      case 'seed-sql':
        ctx.out(seedSql(need(args, 1)[0] ?? '', readMigrations(root)));
        return 0;
      case 'snapshot-sql':
        ctx.out(snapshotSql(need(args, 1)[0] ?? ''));
        return 0;
      case 'rename-sql': {
        const [from = '', to = ''] = need(args, 2);
        ctx.out(renameSql(from, to));
        return 0;
      }
      case 'drop-sql':
        ctx.out(dropSql(need(args, 1)));
        return 0;
      case 'residue-sql':
        ctx.out(RESIDUE_SQL);
        return 0;
      case 'compare': {
        const [a = '', b = ''] = need(args, 2);
        const result = compareSnapshots(parseSnapshot(readFileSync(a, 'utf8')), parseSnapshot(readFileSync(b, 'utf8')));
        for (const line of result.lines) ctx.out(line);
        return result.ok ? 0 : 1;
      }
      default:
        ctx.err(USAGE);
        return 1;
    }
  } catch (error) {
    ctx.err(`restore-drill: ${error instanceof Error ? error.message : String(error)}`);
    if (cmd === 'compare') ctx.out('DRILL FAILED 대조 실행 오류');
    return 1;
  }
}
