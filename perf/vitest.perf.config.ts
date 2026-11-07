import { defineConfig } from 'vitest/config';

/** FR-SYNC-01 (a) 지연 측정(실DB·실소켓). PR 게이트 밖에서 수동 실행한다(DEV_DESIGN §5 표). */
export default defineConfig({
  test: {
    include: ['perf/**/*.perf.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-perf.json' },
    fileParallelism: false,
  },
});
