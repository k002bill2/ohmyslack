interface NavigatorLike {
  readonly serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
}

/**
 * 운영 빌드에서만 `/sw.js`를 등록한다(dev 서버 미등록). SW 미지원 브라우저는 일반 웹으로 그대로 동작한다.
 * 등록 실패는 앱 동작에 영향이 없어 삼킨다(셸 캐시가 없을 뿐).
 */
export function registerServiceWorker({ prod, navigator }: { readonly prod: boolean; readonly navigator: NavigatorLike }): boolean {
  if (!prod || navigator.serviceWorker === undefined) return false;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  return true;
}
