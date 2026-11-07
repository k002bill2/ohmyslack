import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: '../../reports/vitest-web.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.tsx'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../../reports/coverage/web',
    },
  },
});
