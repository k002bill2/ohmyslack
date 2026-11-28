import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunContext } from './lib/cli.ts';
import { run as assertTestDb } from './assert-test-db.ts';

/**
 * `pnpm test:int` 래퍼: 테스트 DB 검사 → vitest(int 설정) 실행, 출력을 터미널과 INT_LOG_FILE에 함께 남긴다(종료 코드 보존).
 * check:log-leak은 이 로그가 없거나 마지막 int 실행 결과(INT_RESULT_FILE)보다 오래되면 실패한다(정본: DEV_DESIGN §5-1).
 */
export const INT_LOG_FILE = 'reports/int/test-int.log';
/** vitest.int.config.ts의 json reporter outputFile — int 실행마다 갱신된다. */
export const INT_RESULT_FILE = 'reports/vitest-int.json';
/** 로그 끝 표식. vitest가 결과 JSON을 쓴 뒤에 붙으므로 로그 mtime이 결과 파일보다 늦다. */
export const INT_LOG_TRAILER = '[test:int] exit=';

export type IntSpawn = (args: readonly string[], cwd: string, onChunk: (chunk: Buffer | string) => void) => Promise<number>;

const VITEST_ARGS = ['exec', 'vitest', 'run', '--config', 'vitest.int.config.ts', '--passWithNoTests'];

export const spawnVitest: IntSpawn = (args, cwd, onChunk) =>
  new Promise((resolve) => {
    const child = spawn('pnpm', [...args], { cwd, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });

export async function runTestInt(argv: readonly string[], ctx: RunContext, exec: IntSpawn): Promise<number> {
  const dbCheck = await assertTestDb([], ctx);
  if (dbCheck !== 0) return dbCheck;
  const target = join(ctx.cwd, INT_LOG_FILE);
  mkdirSync(dirname(target), { recursive: true });
  const log = createWriteStream(target);
  const code = await exec([...VITEST_ARGS, ...argv], ctx.cwd, (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  log.write(`\n${INT_LOG_TRAILER}${code}\n`);
  await new Promise<void>((resolve, reject) => {
    log.on('error', reject);
    log.end(resolve);
  });
  return code;
}

export async function run(argv: readonly string[], ctx: RunContext): Promise<number> {
  return runTestInt(argv, ctx, spawnVitest);
}
