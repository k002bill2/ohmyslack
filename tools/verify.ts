import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './lib/cli.ts';

/** PR 게이트 단계(정본: DEV_DESIGN §5-1 순서). */
export interface VerifyStep {
  readonly label: string;
  readonly args: readonly string[];
  /** 설정되면 실행하지 않고 SKIPPED 배너를 출력한다. */
  readonly skipReason?: string;
  /** 설정되면 stdout·stderr를 이 경로(저장소 루트 기준)에도 기록한다. */
  readonly logFile?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export const INT_LOG_FILE = 'reports/int/test-int.log';
const SKIP_INT = 'SKIPPED (VERIFY_SKIP_INT=1)';

export function buildSteps(env: RunContext['env']): readonly VerifyStep[] {
  const skipInt = env.VERIFY_SKIP_INT === '1';
  const intSkip = skipInt ? { skipReason: SKIP_INT } : {};
  return [
    { label: 'install', args: ['install', '--frozen-lockfile'] },
    { label: 'typecheck', args: ['-r', 'typecheck'] },
    { label: 'lint', args: ['-r', 'lint'] },
    { label: 'test', args: ['-r', 'test', '--coverage'] },
    { label: 'test:int', args: ['test:int'], logFile: INT_LOG_FILE, ...intSkip },
    { label: 'build', args: ['-r', 'build'] },
    { label: 'check:cleanroom', args: ['check:cleanroom'] },
    { label: 'check:no-persist-cache', args: ['check:no-persist-cache'] },
    { label: 'check:design-tokens', args: ['check:design-tokens'] },
    { label: 'check:fr-coverage', args: ['check:fr-coverage', '--mode=progress'] },
    { label: 'check:log-leak', args: ['check:log-leak'] },
    { label: 'audit', args: ['audit', '--prod', '--audit-level=high'] },
  ];
}

export type Exec = (step: VerifyStep, cwd: string) => number;

/** 실제 실행기: 로그 파일이 없으면 터미널로 그대로 흘리고, 있으면 캡처 후 파일과 터미널에 함께 쓴다. */
export const spawnExec: Exec = (step, cwd) => {
  const env = { ...process.env, ...step.env };
  if (step.logFile === undefined) {
    const res = spawnSync('pnpm', [...step.args], { cwd, env, stdio: 'inherit' });
    return res.status ?? 1;
  }
  const res = spawnSync('pnpm', [...step.args], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const target = join(cwd, step.logFile);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, text);
  process.stdout.write(text);
  return res.status ?? 1;
};

function banner(ctx: RunContext, text: string): void {
  const bar = '='.repeat(Math.max(40, text.length + 8));
  ctx.out(bar);
  ctx.out(`=== ${text}`);
  ctx.out(bar);
}

export async function runVerify(ctx: RunContext, exec: Exec): Promise<number> {
  rmSync(join(ctx.cwd, 'reports'), { recursive: true, force: true });
  const steps = buildSteps(ctx.env);
  for (const [index, step] of steps.entries()) {
    const head = `[${index + 1}/${steps.length}] pnpm ${step.args.join(' ')}`;
    if (step.skipReason !== undefined) {
      banner(ctx, `${head} — ${step.skipReason}`);
      continue;
    }
    ctx.out(`\n>>> ${head}`);
    const code = exec(step, ctx.cwd);
    ctx.out(`<<< ${head} EXIT=${code}`);
    if (code !== 0) {
      banner(ctx, `VERIFY FAILED at ${step.label} (EXIT=${code})`);
      return 1;
    }
  }
  banner(ctx, 'VERIFY PASSED');
  return 0;
}

export async function run(_argv: readonly string[], ctx: RunContext): Promise<number> {
  return runVerify(ctx, spawnExec);
}
