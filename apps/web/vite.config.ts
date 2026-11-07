import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** 빌드 훅 안에서만 계산한다(jsdom 테스트가 이 모듈을 import할 때 import.meta.url이 file:이 아님). */
const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const SW_PLACEHOLDER = /(["'`])__OMS_PRECACHE_MANIFEST__\1/;
/** 해시 없는 셸 파일(public/). 아이콘 원본 SVG(source·alt-source·maskable-source)·`fonts/`(해시 없는 2MB 폰트)는 제외. */
export const PUBLIC_SHELL = [
  'manifest.webmanifest',
  'favicon.ico',
  'icons/favicon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon-mono.svg',
] as const;

export interface BuildPrecacheEntry {
  readonly url: string;
  readonly revision: string | null;
}

function revisionOf(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 빌드 산출물로 precache 목록을 만든다(TRD §6: 해시된 앱 셸만). `assets/`의 해시 파일은 revision 없이,
 * index.html·public 셸 파일은 내용 해시를 revision으로. sw.js·소스맵·`/api` 경로는 넣지 않는다.
 */
export function buildPrecacheEntries(
  bundleFiles: Readonly<Record<string, string | Uint8Array>>,
  publicFiles: Readonly<Record<string, string | Uint8Array>>,
): readonly BuildPrecacheEntry[] {
  const allowed = (name: string) =>
    !name.startsWith('api/') && name !== 'api' && name !== 'sw.js' && !name.endsWith('.map') && name !== 'precache-manifest.json';
  const hashed = Object.keys(bundleFiles)
    .filter((name) => allowed(name) && name.startsWith('assets/'))
    .sort()
    .map((name) => ({ url: `/${name}`, revision: null }));
  const shell = Object.entries({ ...publicFiles, ...(bundleFiles['index.html'] === undefined ? {} : { 'index.html': bundleFiles['index.html'] }) })
    .filter(([name]) => allowed(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => ({ url: `/${name}`, revision: revisionOf(content) }));
  return [...hashed, ...shell];
}

/**
 * `features/pwa/sw.ts`를 `/sw.js`(고정 이름)로 빌드하고 precache 목록을 주입한다. PWA 플러그인·workbox 없이 직접(★1).
 * 같은 목록을 `precache-manifest.json`으로도 내보내 `check:no-persist-cache` 3단계와 사람이 확인할 수 있게 한다.
 */
export function swPlugin(): Plugin {
  return {
    name: 'ohmyslack-sw',
    apply: 'build',
    enforce: 'post',
    buildStart() {
      this.emitFile({ type: 'chunk', id: fromHere('./src/features/pwa/sw.ts'), fileName: 'sw.js' });
    },
    generateBundle(_options, bundle) {
      const files: Record<string, string | Uint8Array> = {};
      for (const [name, item] of Object.entries(bundle)) files[name] = item.type === 'chunk' ? item.code : item.source;
      const publicFiles = Object.fromEntries(PUBLIC_SHELL.map((name) => [name, readFileSync(fromHere(`./public/${name}`))]));
      const entries = buildPrecacheEntries(files, publicFiles);
      const sw = bundle['sw.js'];
      if (sw?.type !== 'chunk' || !SW_PLACEHOLDER.test(sw.code)) this.error('sw.js precache placeholder missing');
      if (sw.imports.length > 0 || sw.exports.length > 0) this.error('sw.js must be a single classic script');
      sw.code = sw.code.replace(SW_PLACEHOLDER, JSON.stringify(entries));
      this.emitFile({ type: 'asset', fileName: 'precache-manifest.json', source: `${JSON.stringify(entries, null, 2)}\n` });
    },
  };
}

// 시각 표시 테스트는 디자인 §7-2 예시(KST)를 단언한다. 실행 환경 시간대(CI는 UTC)에 결과가 흔들리지 않게 테스트 프로세스만 고정한다.
if (process.env.VITEST) process.env.TZ = 'Asia/Seoul';

export default defineConfig({
  plugins: [react(), tokensCssPlugin(), swPlugin()],
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
