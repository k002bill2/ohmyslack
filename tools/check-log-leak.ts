import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFlags, type RunContext } from './lib/cli.ts';
import { LOG_CANARIES } from './log-canaries.ts';

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
  const intDir = join(reportsDir, INT_LOG_DIR);
  const logs = existsSync(intDir) ? listLogs(intDir) : [];
  if (logs.length === 0) {
    ctx.out('check:log-leak: 검사 대상 없음 (reports/int/*.log 0개)');
    return 0;
  }
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
