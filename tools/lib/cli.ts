/** 검사 스크립트 공용 실행 계약. 각 스크립트는 run()을 export하고 bin/은 얇은 래퍼만 둔다(커버리지 측정용). */
export interface RunContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export type RunFn = (argv: readonly string[], ctx: RunContext) => Promise<number>;

/** `--key=value` / `--key value` / `--flag` 형식만 지원한다. */
export function parseFlags(argv: readonly string[]): Readonly<Record<string, string>> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = 'true';
    }
  }
  return flags;
}

export function processContext(): RunContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

/** bin 래퍼에서 호출: 예외는 실행 오류(exit 1)로 처리한다. */
export async function runCli(run: RunFn): Promise<void> {
  const ctx = processContext();
  try {
    process.exitCode = await run(process.argv.slice(2), ctx);
  } catch (error) {
    ctx.err(`실행 오류: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
