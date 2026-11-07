import { afterEach, beforeEach, describe, it } from 'vitest';
import { setupE2e, teardownE2e, type E2eContext } from './support/harness.js';
import { runReconnectScenario } from './support/reconnect-scenario.js';

/** 실제 60초 단절. PR 게이트(`*.e2e.test.ts`)에서 제외하고 e2e/vitest.realgap.config.ts로만 실행한다. */
let ctx: E2eContext | undefined;
beforeEach(async () => {
  ctx = await setupE2e();
});
afterEach(async () => {
  await teardownE2e(ctx);
});

describe('재연결 catch-up(실제 60초 단절)', () => {
  it('FR-SYNC-02 실제 60초 단절 후 복귀하면 catch-up과 실시간 경합에서도 최종 상태가 원장과 같고 누락·중복 0이다', async () => {
    if (ctx === undefined) throw new Error('ctx 없음');
    await runReconnectScenario(ctx, 60_000);
  }, 180_000);
});
