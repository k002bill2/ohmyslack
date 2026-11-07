import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildTokensCss } from './src/ui/tokens.css.js';

/**
 * 토큰 CSS를 가상 `.css` 모듈로 제공한다. `main.tsx`가 import하면 vite build가 해시된 정적 CSS 파일로
 * 추출해 `<link rel="stylesheet">`로 연결한다 — 런타임 `<style>` 주입이 없어 CSP `style-src 'self'`와 충돌하지 않는다.
 */
export const TOKENS_CSS_ID = 'virtual:tokens.css';

export function tokensCssPlugin(): Plugin {
  return {
    name: 'ohmyslack-tokens-css',
    resolveId(id) {
      return id === TOKENS_CSS_ID ? TOKENS_CSS_ID : undefined;
    },
    load(id) {
      return id === TOKENS_CSS_ID ? buildTokensCss() : undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), tokensCssPlugin()],
  build: { cssCodeSplit: false },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
    reporters: ['default', 'json'],
    outputFile: { json: '../../reports/vitest-web.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.tsx'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../../reports/coverage/web',
      thresholds: { lines: 80 },
    },
  },
});
