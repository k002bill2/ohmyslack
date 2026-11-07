import { defineConfig } from 'vitest/config';

/** 루트(tools/) 전용 설정. 패키지는 각자 vitest 설정을 쓴다. */
export default defineConfig({
  test: {
    include: ['tools/test/**/*.test.ts', 'perf/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-tools.json' },
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['tools/**/*.ts'],
      exclude: ['tools/bin/**', 'tools/test/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'reports/coverage/tools',
      thresholds: { lines: 80 },
    },
  },
});
