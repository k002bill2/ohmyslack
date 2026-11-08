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
import { createPushHandlers, type ClientsLike, type NotificationClickEventLike, type PushEventLike } from './push-notify.js';

/** 빌드 후처리가 이 문자열 리터럴을 precache 배열 리터럴로 바꾼다(미치환이면 빈 목록). */
const BUILD_MANIFEST: unknown = '__OMS_PRECACHE_MANIFEST__';

interface SwScope {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationClickEventLike) => void): void;
  readonly registration: { showNotification(title: string, options: object): Promise<void> };
  readonly clients: ClientsLike & { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
}

if ('ServiceWorkerGlobalScope' in globalThis) {
  const scope = globalThis as unknown as SwScope;
  const storage: CacheStorageLike = {
    open: async (name) => {
      const cache = await caches.open(name);
      return {
        // HTTP 캐시에 남은 이전 셸(index.html 등)이 새 버전 캐시에 섞이지 않게 재검증 없이 새로 받는다(Codex P2).
        addAll: (urls) => cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' }))),
        match: (request) => cache.match(request as unknown as Request | string),
      };
    },
    keys: () => caches.keys(),
    delete: (name) => caches.delete(name),
  };
  const handlers = createSwHandlers({
    storage,
    lifecycle: { skipWaiting: () => scope.skipWaiting(), claimClients: () => scope.clients.claim() },
    fetcher: (request) => fetch(request as unknown as Request),
    entries: parsePrecacheManifest(BUILD_MANIFEST),
    origin: globalThis.location.origin,
  });
  scope.addEventListener('install', handlers.onInstall);
  scope.addEventListener('activate', handlers.onActivate);
  scope.addEventListener('fetch', handlers.onFetch);
  // TRD §6-2: 알림 표시만 — payload·본문은 어디에도 저장하지 않는다.
  const push = createPushHandlers({
    showNotification: (title, options) => scope.registration.showNotification(title, options),
    clients: scope.clients,
    origin: globalThis.location.origin,
  });
  scope.addEventListener('push', push.onPush);
  scope.addEventListener('notificationclick', push.onNotificationClick);
}
