import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.unit.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: '../../reports/vitest-server.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../../reports/coverage/server',
    },
  },
});
