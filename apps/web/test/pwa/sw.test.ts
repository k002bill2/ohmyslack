import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_PREFIX,
  cacheNameFor,
  createSwHandlers,
  parsePrecacheManifest,
  routeRequest,
  type PrecacheEntry,
} from '../../src/features/pwa';
import { fakeCacheStorage, fetchEvent, request } from './fakes.js';

const ORIGIN = 'https://app.test';
const ENTRIES: readonly PrecacheEntry[] = [
  { url: '/assets/index-Ab12Cd34.js', revision: null },
  { url: '/assets/index-Ef56Gh78.css', revision: null },
  { url: '/index.html', revision: 'r1' },
];

function handlers(storage = fakeCacheStorage().storage, fetcher = vi.fn(async () => new Response('net'))) {
  return { h: createSwHandlers({ storage, fetcher, entries: ENTRIES, origin: ORIGIN }), fetcher, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('features/pwa/sw 라우팅', () => {
  it('/api/**·/api/ws·비GET·교차 출처는 우회하고 precache 셸만 셸 경로, 탐색은 navigate', () => {
    const shell = new Set(ENTRIES.map((e) => e.url));
    expect(routeRequest(request('/api'), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/api/messages?after=1'), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/api/ws'), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/api/auth/login', { method: 'POST' }), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/assets/index-Ab12Cd34.js', { method: 'POST' }), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/assets/index-Ab12Cd34.js', { origin: 'https://evil.test' }), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/assets/unknown.js'), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request('/assets/index-Ab12Cd34.js'), ORIGIN, shell)).toBe('shell');
    expect(routeRequest(request('/c/c1', { mode: 'navigate' }), ORIGIN, shell)).toBe('navigate');
    expect(routeRequest(request('/api/x', { mode: 'navigate' }), ORIGIN, shell)).toBe('bypass');
  });

  it('precache manifest는 해시된 정적 자원·셸만 남기고 /api·잘못된 항목을 버린다', () => {
    expect(parsePrecacheManifest('__OMS_PRECACHE_MANIFEST__')).toEqual([]);
    expect(
      parsePrecacheManifest([
        ...ENTRIES,
        { url: '/api/messages', revision: null },
        { url: '/api', revision: null },
        { url: 'https://cdn.test/x.js', revision: null },
        { url: 42 },
        null,
      ]),
    ).toEqual(ENTRIES);
  });

  it('install은 새 버전 캐시에 precache, activate는 이전 버전 셸 캐시만 지운다', async () => {
    const name = cacheNameFor(ENTRIES);
    expect(name.startsWith(CACHE_PREFIX)).toBe(true);
    expect(cacheNameFor([...ENTRIES, { url: '/assets/b.js', revision: null }])).not.toBe(name);
    const { storage, stores } = fakeCacheStorage({ [`${CACHE_PREFIX}old`]: ['/index.html'], 'other-app': ['/x'] });
    const { h } = handlers(storage);
    const waits: Promise<unknown>[] = [];
    h.onInstall({ waitUntil: (p) => waits.push(p) });
    h.onActivate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect([...stores.keys()].sort()).toEqual([name, 'other-app'].sort());
    expect([...(stores.get(name)?.keys() ?? [])]).toEqual(ENTRIES.map((e) => e.url));
  });

  it('셸은 cache-first, 탐색은 네트워크 우선·오프라인 시 캐시된 셸, 우회 요청은 respondWith 하지 않는다', async () => {
    const { storage } = fakeCacheStorage({ [cacheNameFor(ENTRIES)]: ['/assets/index-Ab12Cd34.js', '/index.html'] });
    const fetcher = vi.fn(async () => new Response('net'));
    const { h } = handlers(storage, fetcher);

    const api = fetchEvent(request('/api/messages'));
    h.onFetch(api);
    expect(api.respondWith).not.toHaveBeenCalled();

    const asset = fetchEvent(request('/assets/index-Ab12Cd34.js'));
    h.onFetch(asset);
    expect(await (await (asset.respondWith.mock.calls[0]?.[0] as Promise<Response>)).text()).toBe('old:/assets/index-Ab12Cd34.js');
    expect(fetcher).not.toHaveBeenCalled();

    const nav = fetchEvent(request('/c/c1', { mode: 'navigate' }));
    h.onFetch(nav);
    expect(await (await (nav.respondWith.mock.calls[0]?.[0] as Promise<Response>)).text()).toBe('net');

    fetcher.mockRejectedValueOnce(new TypeError('offline'));
    const offline = fetchEvent(request('/c/c1', { mode: 'navigate' }));
    h.onFetch(offline);
    expect(await (await (offline.respondWith.mock.calls[0]?.[0] as Promise<Response>)).text()).toBe('old:/index.html');
  });

  it('캐시 미스 셸 자원은 네트워크로 받고 캐시에 새로 쓰지 않는다', async () => {
    const { storage, stores } = fakeCacheStorage();
    const { h, fetcher } = handlers(storage);
    const asset = fetchEvent(request('/assets/index-Ab12Cd34.js'));
    h.onFetch(asset);
    expect(await (await (asset.respondWith.mock.calls[0]?.[0] as Promise<Response>)).text()).toBe('net');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(stores.get(cacheNameFor(ENTRIES))?.size ?? 0).toBe(0);
  });

  it('sw.ts 진입점은 SW 전역에서만 install·activate·fetch 리스너를 건다', async () => {
    const add = vi.spyOn(globalThis, 'addEventListener');
    await import('../../src/features/pwa/sw.js');
    expect(add).not.toHaveBeenCalled();
    vi.resetModules();
    vi.stubGlobal('ServiceWorkerGlobalScope', class {});
    vi.stubGlobal('caches', fakeCacheStorage().storage);
    await import('../../src/features/pwa/sw.js');
    expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(['activate', 'fetch', 'install']);
    add.mockRestore();
  });
});
