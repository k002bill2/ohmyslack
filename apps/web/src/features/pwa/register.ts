export interface ControllerContainerLike {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

interface NavigatorLike {
  readonly serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> } & Partial<ControllerContainerLike>;
}

/**
 * 새 SW가 열린 페이지를 장악하면(`skipWaiting`+`clients.claim`, W-23b) 1회만 새로 고친다 — 옛 셸 JS가 새 SW·새 캐시와
 * 섞이지 않게. 첫 설치(장악 전 controller 없음)는 이미 최신 셸이라 새로 고치지 않는다. 루프 방지 플래그는 메모리만(B7).
 */
export function reloadOnControllerChange(container: ControllerContainerLike, reload: () => void): void {
  let previous = container.controller;
  let reloaded = false;
  container.addEventListener('controllerchange', () => {
    const replaced = previous !== null && previous !== undefined;
    previous = container.controller;
    if (!replaced || reloaded) return;
    reloaded = true;
    reload();
  });
}

/**
 * 운영 빌드에서만 `/sw.js`를 등록한다(dev 서버 미등록). SW 미지원 브라우저는 일반 웹으로 그대로 동작한다.
 * 등록 실패는 앱 동작에 영향이 없어 삼킨다(셸 캐시가 없을 뿐).
 */
export function registerServiceWorker({
  prod,
  navigator,
  reload = () => globalThis.location.reload(),
}: {
  readonly prod: boolean;
  readonly navigator: NavigatorLike;
  readonly reload?: () => void;
}): boolean {
  const sw = navigator.serviceWorker;
  if (!prod || sw === undefined) return false;
  if (typeof sw.addEventListener === 'function') {
    reloadOnControllerChange(sw as ControllerContainerLike, reload);
  }
  sw.register('/sw.js', { scope: '/' }).catch(() => undefined);
  return true;
}
