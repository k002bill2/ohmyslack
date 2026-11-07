import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: '../../reports/vitest-shared.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../../reports/coverage/shared',
    },
  },
});
