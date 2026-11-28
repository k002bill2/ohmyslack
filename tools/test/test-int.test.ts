import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run as checkLogLeak } from '../check-log-leak.ts';
import { INT_LOG_FILE, INT_LOG_TRAILER, INT_RESULT_FILE, runTestInt, type IntSpawn } from '../test-int.ts';
import { captureCtx } from './helpers.ts';

const DB = { TEST_DATABASE_URL: 'postgres://u@127.0.0.1:5432/ohmyslack_test' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** vitest 흉내: 출력 조각을 내고, 끝나기 직전에 결과 JSON을 쓴 뒤 code로 끝난다. */
function fakeVitest(cwd: string, code: number, chunks: readonly string[]): IntSpawn {
  return async (_args, _cwd, onChunk) => {
    for (const chunk of chunks) onChunk(chunk);
    await sleep(15);
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    writeFileSync(join(cwd, INT_RESULT_FILE), '{}');
    return code;
  };
}

describe('test-int wrapper', () => {
  it('tees vitest output to reports/int/test-int.log, appends the exit trailer and keeps a passing exit code', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'testint-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const args: string[][] = [];
    const exec: IntSpawn = async (a, c, onChunk) => {
      args.push([...a]);
      return fakeVitest(cwd, 0, ['RUN v5\n', ' ✓ a.int.test.ts\n'])(a, c, onChunk);
    };
    expect(await runTestInt(['apps/server/test/x.int.test.ts'], captureCtx(cwd, DB), exec)).toBe(0);
    vi.restoreAllMocks();
    const log = readFileSync(join(cwd, INT_LOG_FILE), 'utf8');
    expect(log).toContain(' ✓ a.int.test.ts');
    expect(log).toContain(`${INT_LOG_TRAILER}0`);
    expect(args[0]).toEqual(expect.arrayContaining(['vitest', 'run', '--config', 'vitest.int.config.ts', 'apps/server/test/x.int.test.ts']));
    // 로그가 결과 JSON보다 늦게 끝나므로 이어지는 check:log-leak은 이번 실행 로그를 검사한다.
    expect(statSync(join(cwd, INT_LOG_FILE)).mtimeMs).toBeGreaterThanOrEqual(statSync(join(cwd, INT_RESULT_FILE)).mtimeMs);
    expect(await checkLogLeak([], captureCtx(cwd, {}))).toBe(0);
  });

  it('preserves a failing vitest exit code and still writes the log', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'testint-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runTestInt([], captureCtx(cwd, DB), fakeVitest(cwd, 3, ['FAIL x\n']))).toBe(3);
    vi.restoreAllMocks();
    expect(readFileSync(join(cwd, INT_LOG_FILE), 'utf8')).toContain(`FAIL x\n\n${INT_LOG_TRAILER}3`);
  });

  it('refuses a non-test database without running vitest or touching the log', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'testint-'));
    const exec = vi.fn<IntSpawn>();
    const ctx = captureCtx(cwd, { TEST_DATABASE_URL: 'postgres://u@127.0.0.1:5432/ohmyslack' });
    expect(await runTestInt([], ctx, exec)).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, INT_LOG_FILE))).toBe(false);
  });

  it('a later vitest-only run (no wrapper) makes the old log stale for check:log-leak', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'testint-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runTestInt([], captureCtx(cwd, DB), fakeVitest(cwd, 0, ['ok\n']));
    vi.restoreAllMocks();
    await sleep(20);
    writeFileSync(join(cwd, INT_RESULT_FILE), '{}');
    expect(await checkLogLeak([], captureCtx(cwd, {}))).toBe(1);
  });
});
