import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IMMUTABLE_CACHE, resolveWebDistDir } from '../../src/static/index.js';
import { HOST, testApp } from '../support/auth-app.js';

/** 정적 셸 서빙(TRD §6, DEV_DESIGN §2-2 B7): 캐시 헤더·SPA fallback·/api JSON 404·S6 헤더·경로 탈출 차단. */
let base: string;
let dist: string;
let app: FastifyInstance | undefined;
const INDEX = '<!doctype html><title>shell</title>';
const SECRET_OUTSIDE = 'outside-secret-content';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'oms-static-'));
  dist = join(base, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'icons'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"x"}');
  writeFileSync(join(dist, 'precache-manifest.json'), '[]');
  writeFileSync(join(dist, 'assets', 'index-AbC123.js'), 'console.info(1)');
  writeFileSync(join(dist, 'icons', 'icon-192.png'), 'png');
  writeFileSync(join(dist, '.env'), 'DOTFILE');
  writeFileSync(join(base, 'outside.txt'), SECRET_OUTSIDE);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function get(url: string, accept = '*/*', method: 'GET' | 'HEAD' = 'GET') {
  app ??= testApp({ webDistDir: dist });
  return app.inject({ method, url, headers: { host: HOST, accept } });
}

function expectS6(headers: Record<string, unknown>): void {
  const csp = String(headers['content-security-policy']);
  // worker-src 지시어가 없으면 script-src → default-src 'self'로 대체된다(CSP3) — SW는 같은 출처만.
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/worker-src|script-src/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
}

describe('캐시 헤더', () => {
  it('해시된 /assets/* → immutable 1년', async () => {
    const res = await get('/assets/index-AbC123.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE);
    expect(String(res.headers['content-type'])).toContain('javascript');
    expectS6(res.headers);
  });

  it.each(['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/precache-manifest.json', '/icons/icon-192.png'])(
    '%s → no-cache',
    async (url) => {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
      expectS6(res.headers);
    },
  );

  it('HEAD도 같은 헤더', async () => {
    const res = await get('/sw.js', '*/*', 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});

describe('SPA fallback·/api', () => {
  it('없는 경로 + Accept HTML → index.html(no-cache, S6)', async () => {
    const res = await get('/c/some-channel', 'text/html,application/xhtml+xml');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expectS6(res.headers);
  });

  it('없는 경로 + HTML 아님 → JSON 404', async () => {
    const res = await get('/assets/missing.js');
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it.each(['/api/nope', '/%61pi/nope', '/API/nope', '//api/nope'])('%s + Accept HTML → JSON 404 no-store(SPA 아님)', async (url) => {
    const res = await get(url, 'text/html');
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('/api/healthz는 그대로 API', async () => {
    const res = await get('/api/healthz', 'text/html');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('비-GET 미등록 경로는 기존 404', async () => {
    app = testApp({ webDistDir: dist });
    const res = await app.inject({ method: 'POST', url: '/c/x', headers: { host: HOST, origin: 'https://ohmy.test' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('경로 탈출·점 파일 차단', () => {
  it.each(['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/.env', '/%2eenv', '/assets/..\\..\\outside.txt'])(
    '%s → 파일 내용 노출 없음',
    async (url) => {
      for (const accept of ['*/*', 'text/html']) {
        const res = await get(url, accept);
        expect(res.body).not.toContain(SECRET_OUTSIDE);
        expect(res.body).not.toContain('DOTFILE');
        if (res.statusCode === 200) expect(res.body).toBe(INDEX);
      }
    },
  );
});

describe('dist 해석', () => {
  it('WEB_DIST_DIR가 디렉터리면 절대 경로, 없으면 undefined', () => {
    expect(resolveWebDistDir({ WEB_DIST_DIR: dist })).toBe(dist);
    expect(resolveWebDistDir({ WEB_DIST_DIR: join(base, 'nope') })).toBeUndefined();
    expect(resolveWebDistDir({ WEB_DIST_DIR: join(dist, 'index.html') })).toBeUndefined();
    const fallback = resolveWebDistDir({});
    if (fallback !== undefined) expect(fallback.endsWith(join('apps', 'web', 'dist'))).toBe(true);
  });

  it('webDistDir 없음 → API만(정적 라우트 미등록, / 는 404)', async () => {
    app = testApp({});
    expect((await app.inject({ method: 'GET', url: '/api/healthz', headers: { host: HOST } })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST, accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(app.accessRoutes.some((r) => r.url === '/*')).toBe(false);
  });
});
