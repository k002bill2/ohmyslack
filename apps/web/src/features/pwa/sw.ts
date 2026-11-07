/**
 * 서비스 워커 진입점(빌드 시 `/sw.js` 고정 이름, 단일 파일·import/export 없음 — vite.config.ts `swPlugin`).
 * DEV_DESIGN §2-2 B7 예외: 이 파일만 Cache Storage(`caches`)를 쓴다 — 해시된 앱 셸 정적 자원 전용.
 */
import {
  createSwHandlers,
  parsePrecacheManifest,
  type CacheStorageLike,
  type ExtendableEventLike,
  type FetchEventLike,
} from './sw-routing.js';

/** 빌드 후처리가 이 문자열 리터럴을 precache 배열 리터럴로 바꾼다(미치환이면 빈 목록). */
const BUILD_MANIFEST: unknown = '__OMS_PRECACHE_MANIFEST__';

interface SwScope {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

if ('ServiceWorkerGlobalScope' in globalThis) {
  const scope = globalThis as unknown as SwScope;
  const storage: CacheStorageLike = {
    open: async (name) => {
      const cache = await caches.open(name);
      return {
        addAll: (urls) => cache.addAll([...urls]),
        match: (request) => cache.match(request as unknown as Request | string),
      };
    },
    keys: () => caches.keys(),
    delete: (name) => caches.delete(name),
  };
  const handlers = createSwHandlers({
    storage,
    fetcher: (request) => fetch(request as unknown as Request),
    entries: parsePrecacheManifest(BUILD_MANIFEST),
    origin: globalThis.location.origin,
  });
  scope.addEventListener('install', handlers.onInstall);
  scope.addEventListener('activate', handlers.onActivate);
  scope.addEventListener('fetch', handlers.onFetch);
}
