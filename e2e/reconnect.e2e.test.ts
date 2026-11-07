import { afterEach, beforeEach, describe, it } from 'vitest';
import { setupE2e, teardownE2e, type E2eContext } from './support/harness.js';
import { runReconnectScenario } from './support/reconnect-scenario.js';

let ctx: E2eContext | undefined;
beforeEach(async () => {
  ctx = await setupE2e();
});
afterEach(async () => {
  await teardownE2e(ctx);
});

describe('재연결 catch-up(압축 단절)', () => {
  it('FR-SYNC-02 단절 중 두 대화 이상에서 100건 생성과 수정·삭제 후 복귀하면 전역 커서 catch-up과 실시간 수신 경합에서도 최종 본문·삭제·순서가 같고 누락·중복 0이다', async () => {
    if (ctx === undefined) throw new Error('ctx 없음');
    await runReconnectScenario(ctx, 0);
  }, 60_000);
});
