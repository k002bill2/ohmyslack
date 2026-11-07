import { defineConfig } from 'vitest/config';

/** 통합·프로토콜 E2E(실DB). 실행 전 tools/assert-test-db.ts가 TEST_DATABASE_URL을 검사한다. */
export default defineConfig({
  test: {
    include: ['apps/server/test/**/*.int.test.ts', 'e2e/**/*.e2e.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-int.json' },
    fileParallelism: false,
  },
});
