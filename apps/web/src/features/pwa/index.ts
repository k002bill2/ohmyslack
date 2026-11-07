/** pwa 기능 공개 API(DEV_DESIGN §2-2 B8). `sw.ts`는 빌드 진입점이라 여기서 내보내지 않는다. */
export {
  CACHE_PREFIX,
  cacheNameFor,
  createSwHandlers,
  parsePrecacheManifest,
  routeRequest,
  type CacheStorageLike,
  type FetchEventLike,
  type PrecacheEntry,
  type RequestLike,
} from './sw-routing.js';
export { registerServiceWorker } from './register.js';
export { detectInstallMode, InstallHint, useInstallPrompt, type InstallCopy, type InstallMode } from './install.js';
