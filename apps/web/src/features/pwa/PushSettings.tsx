import { useCallback, useEffect, useRef, useState } from 'react';
import { PUSH_SETTINGS_COPY } from '../../ui/copy.js';
import { detectInstallMode, InstallHint } from './install.js';
import { ensureActiveWorker, type RegistrationLike } from './sw-ready.js';

/**
 * CMP-30 PushSettings(W-23, UI_STATES §2-10, TRD §6-2). 브라우저 API·서버 호출은 주입한다(테스트).
 * 서버 구독 id는 화면 메모리(모듈 변수)에만 둔다 — 저장소에 쓰지 않는다(B7).
 */

export interface PushSubscriptionLike {
  readonly endpoint: string;
  /** 구독에 결속된 application server key(VAPID 공개키). 회전 감지에 쓴다(없으면 비교 생략). */
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

export interface PushEnv {
  readonly userAgent: string;
  /** `display-mode: standalone` — iOS일 때만 묻는다(그 밖에는 판정에 필요 없음). */
  standalone(): boolean;
  /** `PushManager`·`serviceWorker`·`Notification` 모두 있음. */
  readonly supported: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  pushManager(): Promise<PushManagerLike>;
}

export interface PushServerApi {
  /** `GET /api/push/vapid-public-key`. 404(push 비활성)면 null. */
  vapidPublicKey(): Promise<string | null>;
  /** `POST /api/push/subscriptions`(upsert) → 서버 구독 id. */
  register(subscription: unknown): Promise<string>;
  /** `DELETE /api/push/subscriptions/{id}`. */
  unregister(id: string): Promise<void>;
}

export type PushState = 'loading' | 'unsupported' | 'ios-install' | 'default' | 'denied' | 'subscribed' | 'failed' | 'pending';

/** 이 탭의 서버 구독 id(endpoint별). 새로 고치면 사라지고, 다음 진입 때 upsert로 다시 받는다. */
let knownSubscription: { readonly endpoint: string; readonly id: string } | null = null;

/** 메모리 구독 id를 비운다(세션 종료 시 LiveApp, 테스트). */
export function resetPushMemory(): void {
  knownSubscription = null;
}

/** base64url VAPID 공개 키 → 바이트. */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 실제 브라우저 배선. */
export function browserPushEnv(): PushEnv {
  const supported = 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
  return {
    userAgent: navigator.userAgent,
    standalone: () => typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches,
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    pushManager: async () => {
      const registration = await navigator.serviceWorker.ready;
      await ensureActiveWorker(registration as unknown as RegistrationLike);
      return registration.pushManager as unknown as PushManagerLike;
    },
  };
}

/** 기존 구독이 현재 VAPID 공개키가 아닌 키로 만들어졌으면 true(키 회전, TRD §6-2 「전 구독 재등록」). */
function boundToOtherKey(sub: PushSubscriptionLike, key: string): boolean {
  const bound = sub.options?.applicationServerKey;
  if (bound === undefined || bound === null) return false;
  const current = base64UrlToBytes(key);
  const actual = new Uint8Array(bound);
  return actual.length !== current.length || actual.some((byte, i) => byte !== current[i]);
}

/** 항상 서버에 upsert한다 — 서버 행은 세션에 결속되므로(로그아웃·재로그인 시 삭제) 캐시로 생략하면 「구독됨」인데 수신 0이 된다. */
async function registerSubscription(sub: PushSubscriptionLike, server: PushServerApi): Promise<void> {
  const id = await server.register(sub.toJSON());
  knownSubscription = { endpoint: sub.endpoint, id };
}

function usePushState(env: PushEnv, server: PushServerApi) {
  const [state, setState] = useState<PushState>('loading');
  const key = useRef<string | null>(null);

  const init = useCallback(async () => {
    const ios = detectInstallMode({ standalone: false, canPrompt: false, userAgent: env.userAgent }) === 'ios';
    if (ios && !env.standalone()) return setState('ios-install');
    if (!env.supported) return setState('unsupported');
    try {
      key.current = await server.vapidPublicKey();
      if (key.current === null) return setState('unsupported');
      const permission = env.permission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'default');
      const existing = await (await env.pushManager()).getSubscription();
      if (existing === null) return setState('default');
      if (boundToOtherKey(existing, key.current)) {
        await existing.unsubscribe();
        return setState('default');
      }
      await registerSubscription(existing, server);
      setState('subscribed');
    } catch {
      setState('failed');
    }
  }, [env, server]);

  useEffect(() => {
    void init();
  }, [init]);

  /** 「알림 켜기」·「다시 시도」 클릭: 권한 요청을 가장 먼저(사용자 제스처 안에서) 호출한다. */
  const enable = useCallback(() => {
    const asked = env.requestPermission();
    setState('pending');
    void (async () => {
      try {
        const permission = await asked;
        if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'default');
        if (key.current === null) key.current = await server.vapidPublicKey();
        if (key.current === null) return setState('unsupported');
        const manager = await env.pushManager();
        const sub =
          (await manager.getSubscription()) ??
          (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key.current) }));
        await registerSubscription(sub, server);
        setState('subscribed');
      } catch {
        setState('failed');
      }
    })();
  }, [env, server]);

  const disable = useCallback(() => {
    setState('pending');
    void (async () => {
      try {
        const sub = await (await env.pushManager()).getSubscription();
        if (knownSubscription !== null) await server.unregister(knownSubscription.id);
        knownSubscription = null;
        if (sub !== null) await sub.unsubscribe();
        setState('default');
      } catch {
        setState('failed');
      }
    })();
  }, [env, server]);

  return { state, enable, disable };
}

export function PushSettings({ env, server }: { readonly env: PushEnv; readonly server: PushServerApi }) {
  const { state, enable, disable } = usePushState(env, server);
  const [showInstall, setShowInstall] = useState(false);
  const c = PUSH_SETTINGS_COPY;
  return (
    <section className="push-settings" aria-label={c.title} data-state={state}>
      {state === 'unsupported' && <p>{c.unsupported}</p>}
      {state === 'ios-install' && (
        <>
          <p>{c.iosInstall}</p>
          {showInstall ? (
            <InstallHint mode="ios" onInstall={() => undefined} />
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setShowInstall(true)}>
              {c.openInstallHint}
            </button>
          )}
        </>
      )}
      {(state === 'default' || state === 'pending') && (
        <button type="button" className="btn btn-primary" onClick={enable} disabled={state === 'pending'}>
          {c.enable}
        </button>
      )}
      {state === 'denied' && <p>{c.denied}</p>}
      {state === 'subscribed' && (
        <>
          <p>{c.subscribed}</p>
          <button type="button" className="btn btn-secondary" onClick={disable}>
            {c.disable}
          </button>
        </>
      )}
      {state === 'failed' && (
        <>
          <p role="alert">{c.failed}</p>
          <button type="button" className="btn btn-secondary" onClick={enable}>
            {c.retry}
          </button>
        </>
      )}
    </section>
  );
}
