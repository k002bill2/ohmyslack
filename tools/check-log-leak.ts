import type { RunContext } from './lib/cli.ts';

/** CP1 자리표시자 — CP2(W-02)에서 구현한다. */
export async function run(_argv: readonly string[], ctx: RunContext): Promise<number> {
  ctx.out('check-log-leak: 미구현 (CP2)');
  return 0;
}
