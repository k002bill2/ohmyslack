import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { RunContext } from './lib/cli.ts';
import { INT_LOG_FILE } from './test-int.ts';

// 불변식: verify는 VERIFY_ARTIFACTS 목록(자기 산출물 + 게이트가 읽는 perf JSON)만 지운다.
// reports/ 자체·reports/qa/(수동 QA 증거) 등 목록 밖 경로는 절대 지우지 않는다.

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

/** test:int 래퍼(tools/test-int.ts)가 직접 기록하는 int 로그. verify는 같은 파일을 다시 쓰지 않는다. */
export { INT_LOG_FILE };

/**
 * runVerify 시작 시 지우는 산출물(저장소 루트 기준). stale 결과로 게이트가 오판하지 않게 하려는 목적.
 * 근거: vitest JSON 리포터 outputFile·coverage reportsDirectory(vitest*.config.ts, apps/web/vite.config.ts,
 * perf/vitest.perf.config.ts), INT_LOG_FILE. 리더: check-fr-coverage·check-no-persist-cache는 reports/*.json,
 * check-log-leak은 reports/int/** 를 읽는다.
 */
export const VERIFY_ARTIFACTS: readonly string[] = [
  'reports/vitest-server.json',
  'reports/vitest-web.json',
  'reports/vitest-shared.json',
  'reports/vitest-tools.json',
  'reports/vitest-int.json',
  'reports/vitest-perf.json',
  'reports/coverage/server',
  'reports/coverage/web',
  'reports/coverage/shared',
  'reports/coverage/tools',
  'reports/int',
];

/** 목록 항목만 지운다. 항목이 reports/ 밖이나 reports/ 자체로 해석되면 지우지 않고 throw한다. */
export function cleanArtifacts(cwd: string, artifacts: readonly string[] = VERIFY_ARTIFACTS): void {
  const reportsDir = resolve(cwd, 'reports');
  for (const rel of artifacts) {
    const target = resolve(cwd, rel);
    const inside = relative(reportsDir, target);
    if (inside === '' || inside.startsWith('..') || inside.startsWith(sep) || inside.split(sep)[0] === 'qa') {
      throw new Error(`verify: 산출물 경로가 reports/ 밖이거나 보호 경로입니다 — ${rel}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}
const SKIP_INT = 'SKIPPED (VERIFY_SKIP_INT=1)';

export function buildSteps(env: RunContext['env']): readonly VerifyStep[] {
  const skipInt = env.VERIFY_SKIP_INT === '1';
  const intSkip = skipInt ? { skipReason: SKIP_INT } : {};
  return [
    { label: 'install', args: ['install', '--frozen-lockfile'] },
    { label: 'typecheck', args: ['-r', 'typecheck'] },
    { label: 'lint', args: ['-r', 'lint'] },
    { label: 'test', args: ['-r', 'test', '--coverage'] },
    { label: 'test:int', args: ['test:int'], ...intSkip },
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

/**
 * check-fr-coverage·check-no-persist-cache는 reports/*.json 전체를 Vitest 결과로 읽는다.
 * 목록 밖 최상위 JSON은 지우지 않고(증거 보존) 그 이름을 돌려줘 verify를 멈추게 한다.
 */
export function unexpectedReportJson(cwd: string): string[] {
  const dir = join(cwd, 'reports');
  if (!existsSync(dir)) return [];
  const known = new Set(VERIFY_ARTIFACTS);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !known.has(`reports/${name}`))
    .sort();
}

export async function runVerify(ctx: RunContext, exec: Exec): Promise<number> {
  cleanArtifacts(ctx.cwd);
  const strays = unexpectedReportJson(ctx.cwd);
  if (strays.length > 0) {
    ctx.err(`verify: reports/ 최상위에 목록 밖 JSON이 있어 게이트가 오판할 수 있습니다(삭제하지 않음): ${strays.join(', ')}`);
    banner(ctx, 'VERIFY FAILED at preflight (reports/*.json 정리 필요 — reports/qa/ 등 하위로 옮기세요)');
    return 1;
  }
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
