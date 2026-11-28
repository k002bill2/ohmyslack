import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFlags, type RunContext } from './lib/cli.ts';
import { LOG_CANARIES } from './log-canaries.ts';
import { INT_LOG_FILE, INT_RESULT_FILE } from './test-int.ts';

/** 검사 대상: reports/int 아래의 *.log (test:int 출력). 정본: DEV_DESIGN §5-1 `check:log-leak`. */
export const INT_LOG_DIR = 'int';
const LOG_EXT = '.log';

function listLogs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listLogs(full));
    else if (entry.name.endsWith(LOG_EXT)) found.push(full);
  }
  return found.sort();
}

function scanFile(file: string, base: string): string[] {
  const hits: string[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const [kind, canary] of Object.entries(LOG_CANARIES)) {
      if (line.includes(canary)) hits.push(`${relative(join(base, INT_LOG_DIR), file)}:${index + 1} ${kind} 카나리아`);
    }
  });
  return hits;
}

/**
 * 검사 입력이 이번 int 실행의 것인지. test:int 래퍼 로그(INT_LOG_FILE)가 없거나, vitest int 결과(INT_RESULT_FILE)보다
 * 오래됐으면(래퍼 없이 vitest만 다시 돌린 경우 등) 이유를 돌려준다. 이전 실행 로그를 검사하거나 공허 통과하지 않게 한다.
 */
function intLogFreshness(reportsDir: string): string | undefined {
  const logPath = join(reportsDir, relative('reports', INT_LOG_FILE));
  if (!existsSync(logPath)) return `${INT_LOG_FILE} 가 없습니다(test:int 로그 없음)`;
  const resultPath = join(reportsDir, relative('reports', INT_RESULT_FILE));
  if (!existsSync(resultPath)) return `마지막 int 실행 결과(${INT_RESULT_FILE})가 없어 로그 신선도를 판정할 수 없습니다`;
  if (statSync(resultPath).mtimeMs > statSync(logPath).mtimeMs) {
    return `${INT_LOG_FILE} 가 마지막 int 실행(${INT_RESULT_FILE})보다 오래됐습니다`;
  }
  return undefined;
}

function skipBanner(ctx: RunContext): void {
  const bar = '='.repeat(60);
  ctx.out(bar);
  ctx.out('=== check:log-leak int 로그 입력 — SKIPPED (VERIFY_SKIP_INT=1)');
  ctx.out(bar);
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  if (ctx.env.VERIFY_SKIP_INT === '1') {
    skipBanner(ctx);
    return 0;
  }
  const reportsDir = join(ctx.cwd, parseFlags(argv).reports ?? 'reports');
  if (!existsSync(reportsDir) || !statSync(reportsDir).isDirectory()) {
    ctx.err(`check:log-leak: 실행 오류 — ${reportsDir} 가 없습니다(테스트 단계가 실행되지 않음)`);
    return 1;
  }
  const freshness = intLogFreshness(reportsDir);
  if (freshness !== undefined) {
    ctx.err(`check:log-leak: 실패 — ${freshness} (pnpm test:int를 다시 실행하세요)`);
    return 1;
  }
  const logs = listLogs(join(reportsDir, INT_LOG_DIR));
  const hits: string[] = [];
  try {
    for (const file of logs) hits.push(...scanFile(file, reportsDir));
  } catch (error) {
    ctx.err(`check:log-leak: 실행 오류 — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (hits.length > 0) {
    for (const hit of hits) ctx.err(`누출: ${hit}`);
    ctx.err(`check:log-leak: 실패 — 카나리아 ${hits.length}건`);
    return 1;
  }
  ctx.out(`check:log-leak: OK — 로그 ${logs.length}개, 카나리아 0건`);
  return 0;
}
