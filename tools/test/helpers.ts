import type { RunContext } from '../lib/cli.ts';

export interface CapturedContext extends RunContext {
  readonly lines: string[];
}

/** run()을 프로세스 안에서 호출하기 위한 출력 캡처 컨텍스트. */
export function captureCtx(cwd: string, env: Record<string, string | undefined>): CapturedContext {
  const lines: string[] = [];
  return {
    cwd,
    env,
    lines,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
}
