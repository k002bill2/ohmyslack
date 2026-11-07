import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../check-no-persist-cache.ts';
import { captureCtx } from './helpers.ts';

const SW = 'apps/web/src/features/pwa/sw.ts';
const CHECKPOINT = 'apps/web/src/features/sync/checkpoint.ts';

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'no-persist-'));
  mkdirSync(join(root, 'apps/web/src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function report(name: string, status: string): string {
  return JSON.stringify({ testResults: [{ name, assertionResults: [{ status }] }] });
}

async function check(root: string): Promise<{ code: number; text: string }> {
  const ctx = captureCtx(root, {});
  const code = await run(['--root', root], ctx);
  return { code, text: ctx.lines.join('\n') };
}

describe('check-no-persist-cache', () => {
  it('passes a plain component and checkpoint.ts with passing test evidence', async () => {
    const root = fixture({
      'apps/web/src/App.tsx': 'export const App = () => null;\n',
      [CHECKPOINT]: 'export const save = (n: number) => localStorage.setItem("c", String(n));\n',
      'reports/unit.json': report('/x/apps/web/test/sync/checkpoint.test.ts', 'passed'),
    });
    const { code, text } = await check(root);
    expect(code).toBe(0);
    expect(text).toContain('빌드 산출물 없음 — 건너뜀');
  });

  it('skips evidence check when sw.ts and checkpoint.ts are absent', async () => {
    const root = fixture({ 'apps/web/src/a.ts': 'export const a = 1;\n' });
    const { code, text } = await check(root);
    expect(code).toBe(0);
    expect(text).toContain('sw.ts/checkpoint.ts 미구현 — 단위 테스트 증거 검사 건너뜀');
  });

  it('ignores mentions inside comments', async () => {
    const root = fixture({
      'apps/web/src/a.ts': '// localStorage is banned\n/* indexedDB\n caches */\nexport const a = 1;\n',
    });
    expect((await check(root)).code).toBe(0);
  });

  it('ignores storage words inside string literals (regression: Codex round 2)', async () => {
    const root = fixture({
      'apps/web/src/msg.ts': "export const m = 'localStorage is unavailable';\nexport const n = \"indexedDB off\";\n",
    });
    expect(await run([], captureCtx(root, {}))).toBe(0);
  });

  it('flags window.localStorage in a regular file with file:line', async () => {
    const root = fixture({ 'apps/web/src/a.ts': 'const x = 1;\nwindow.localStorage.clear();\n' });
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('apps/web/src/a.ts:2');
  });

  it('flags indexedDB in a regular file', async () => {
    const root = fixture({ 'apps/web/src/db.tsx': 'indexedDB.open("x");\n' });
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('indexedDB');
  });

  it('flags sw.ts using localStorage (only caches allowed)', async () => {
    const root = fixture({
      [SW]: 'await caches.open("shell");\nlocalStorage.setItem("a", "b");\n',
      'reports/unit.json': report('/x/apps/web/test/pwa/sw.test.ts', 'passed'),
    });
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain(`${SW}:2`);
    expect(text).not.toContain(`${SW}:1`);
  });

  it('flags checkpoint.ts without test evidence', async () => {
    const root = fixture({
      [CHECKPOINT]: 'localStorage.setItem("c", "1");\n',
      'reports/unit.json': report('/x/apps/web/test/sync/checkpoint.test.ts', 'failed'),
    });
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('apps/web/test/sync/checkpoint');
  });

  it('allows a SW that bypasses /api at runtime (regression: Codex P2)', async () => {
    const root = fixture({
      'apps/web/src/App.tsx': 'export const A = 1;\n',
      'apps/web/dist/sw.js':
        'precacheAndRoute([{url:"/assets/a.js"}]);\nself.addEventListener("fetch",e=>{if(new URL(e.request.url).pathname.startsWith("/api/"))return;});\n',
    });
    expect(await run([], captureCtx(root, {}))).toBe(0);
  });

  it('flags a dist SW precache entry for /api', async () => {
    const root = fixture({
      'apps/web/src/a.ts': 'export const a = 1;\n',
      'apps/web/dist/sw.js': 'precacheAndRoute([{url:"/assets/a.js"},{url:"/api/messages"}]);\n',
    });
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('apps/web/dist/sw.js');
  });

  it('passes a clean dist SW and reports dist without SW', async () => {
    const clean = fixture({ 'apps/web/dist/workbox-abc.js': 'precache([{url:"/index.html"}]);\n' });
    expect((await check(clean)).code).toBe(0);
    const noSw = fixture({ 'apps/web/dist/assets/index.js': 'console.log(1);\n' });
    const { code, text } = await check(noSw);
    expect(code).toBe(0);
    expect(text).toContain('SW 산출물 없음');
  });

  it('errors when root is missing', async () => {
    const { code } = await check(join(tmpdir(), 'no-persist-missing-xyz'));
    expect(code).toBe(1);
  });

  it('errors when apps/web/src is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'no-persist-'));
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('apps/web/src');
  });

  it.skipIf(process.getuid?.() === 0)('errors on an unreadable file', async () => {
    const root = fixture({ 'apps/web/src/a.ts': 'export const a = 1;\n' });
    chmodSync(join(root, 'apps/web/src/a.ts'), 0o000);
    const { code, text } = await check(root);
    expect(code).toBe(1);
    expect(text).toContain('실행 오류');
  });

  it('passes on the real repository', async () => {
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    const ctx = captureCtx(repo, {});
    expect(await run([], ctx)).toBe(0);
  });
});
