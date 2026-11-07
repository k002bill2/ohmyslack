import { defineConfig } from 'vitest/config';

/** 실제 60초 단절 E2E(실DB). PR 게이트 밖에서 수동·야간 실행한다. */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e-real.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
