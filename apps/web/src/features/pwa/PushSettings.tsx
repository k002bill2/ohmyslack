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

/**
 * 진행 중인 구독 변경 작업(켜기·끄기·재동기화) 체인 — 모듈 수준이라 화면 인스턴스가 바뀌어도 이어진다.
 * 끄기 중 Dialog를 닫고 다시 열면 새 인스턴스의 재동기화가 이전 DELETE·unsubscribe 뒤에 실제 상태를 읽는다(Codex P1-3).
 * 메모리에만 둔다(B7).
 */
let pushOp: Promise<unknown> = Promise.resolve();

/**
 * 앞 구독 변경 작업을 기다리는 상한(ms). 서버 요청·브라우저 API가 멈춰도 다시 연 설정이 `loading`에 갇히지 않게 한다(Codex 재리뷰 P2).
 * SW 활성 대기 상한(`SW_ACTIVATE_TIMEOUT_MS`)과 같은 10초 — 사용자가 화면을 보며 기다릴 수 있는 한도. 넘으면 그냥 진행한다:
 * 새 작업이 실제 상태를 다시 읽고, 늦게 끝난 앞 작업의 결과는 언마운트된 화면이면 버려진다.
 */
export const PUSH_OP_WAIT_MS = 10_000;

/** `previous`가 끝나거나 `ms`가 지나면(먼저 오는 쪽) 끝난다. 실패는 삼킨다. */
function waitAtMost(previous: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    previous.then(done, done);
  });
}

/** `fn`을 앞선 구독 변경 작업이 끝난 뒤(최대 `PUSH_OP_WAIT_MS`) 실행한다(앞 작업의 실패와 무관). */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = waitAtMost(pushOp, PUSH_OP_WAIT_MS).then(fn);
  pushOp = run.catch(() => undefined);
  return run;
}

/**
 * 구독 상태를 바꾸는 작업(켜기·끄기 본문)의 완료 알림 — 인자는 작업을 시작한 화면 인스턴스 표식.
 * 대기 상한보다 늦게 끝난 앞 작업이 다시 연 화면의 정착 상태를 뒤집어도, 그 화면이 다시 읽어 실제 상태로 수렴한다(Codex 3차 리뷰 P2).
 * 재동기화는 알리지 않는다(루프 방지). 메모리에만 둔다(B7).
 */
const pushChangeListeners = new Set<(origin: object) => void>();

function notifyPushChanged(origin: object): void {
  for (const listener of pushChangeListeners) listener(origin);
}

/** 메모리 구독 id·작업 체인을 비운다(세션 종료 시 LiveApp, 테스트). */
export function resetPushMemory(): void {
  knownSubscription = null;
  pushOp = Promise.resolve();
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

/** 조용한 재동기화 결과 — `PushSettings` 첫 상태와 같다(`loading`·`failed`·`pending` 제외). */
export type PushSyncState = Extract<PushState, 'unsupported' | 'ios-install' | 'default' | 'denied' | 'subscribed'>;

/**
 * 기존 구독을 서버에 조용히 다시 등록한다 — 권한은 절대 요청하지 않는다.
 * iOS 미설치·미지원·VAPID 없음·권한≠granted·구독 없음이면 아무것도 하지 않고, 키 회전이면 unsubscribe만 한다.
 * 오류는 던진다(호출자가 표시 여부를 정한다). `onKey`: 받아 온 VAPID 키(PushSettings가 「알림 켜기」에 재사용).
 */
export async function syncExistingSubscription(env: PushEnv, server: PushServerApi, onKey: (key: string) => void = () => undefined): Promise<PushSyncState> {
  const ios = detectInstallMode({ standalone: false, canPrompt: false, userAgent: env.userAgent }) === 'ios';
  if (ios && !env.standalone()) return 'ios-install';
  if (!env.supported) return 'unsupported';
  const key = await server.vapidPublicKey();
  if (key === null) return 'unsupported';
  onKey(key);
  const permission = env.permission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';
  const existing = await (await env.pushManager()).getSubscription();
  if (existing === null) return 'default';
  if (boundToOtherKey(existing, key)) {
    await existing.unsubscribe();
    return 'default';
  }
  await registerSubscription(existing, server);
  return 'subscribed';
}

/**
 * 앱 진입 시 계정별 1회 재동기화(서버 구독 행은 세션에 결속 — 재로그인 기기도 환경설정을 열지 않고 다시 수신).
 * `accountId`가 없으면(=`/api/me` 응답 전, CSRF 토큰 미설정) 실행하지 않는다 — CSRF 없는 POST는 403(Codex P1-1).
 * 계정이 바뀌면(재로그인·전환) 다시 실행한다. 실패는 조용히 무시한다(UI 없음, 로그 없음 — B6).
 */
export function usePushResync(env: PushEnv | null, server: PushServerApi | undefined, accountId: string | undefined): void {
  useEffect(() => {
    if (env === null || server === undefined || accountId === undefined) return;
    serialize(() => syncExistingSubscription(env, server)).catch(() => undefined);
  }, [env, server, accountId]);
}

function usePushState(env: PushEnv, server: PushServerApi) {
  const [state, setRawState] = useState<PushState>('loading');
  const key = useRef<string | null>(null);
  // 언마운트 뒤 끝난 작업의 결과는 버린다 — 작업 자체는 끝까지 간다(Dialog 닫기를 막지 않음).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setState = useCallback((next: PushState) => {
    if (mounted.current) setRawState(next);
  }, []);

  const init = useCallback(async () => {
    try {
      setState(await serialize(() => syncExistingSubscription(env, server, (k) => (key.current = k))));
    } catch {
      setState('failed');
    }
  }, [env, server, setState]);

  useEffect(() => {
    void init();
  }, [init]);

  // 다른 화면이 시작한 켜기·끄기가 끝나면 실제 상태를 다시 읽는다(체인 뒤에서). 자기 작업은 직접 setState한다.
  const origin = useRef<object>({});
  useEffect(() => {
    const listener = (from: object) => {
      if (from !== origin.current) void init();
    };
    pushChangeListeners.add(listener);
    return () => {
      pushChangeListeners.delete(listener);
    };
  }, [init]);

  /**
   * 「알림 켜기」·「다시 시도」 클릭: 권한 요청을 가장 먼저(사용자 제스처 안에서) 호출한다.
   * 권한 응답 대기는 체인 밖에서 한다 — 프롬프트가 열린 채 Dialog를 닫아도 다시 연 화면의 재동기화를 막지 않는다(Codex 재리뷰 P2).
   */
  const enable = useCallback(() => {
    const asked = env.requestPermission();
    setState('pending');
    void (async () => {
      try {
        const permission = await asked;
        if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'default');
        await serialize(async () => {
          try {
            if (key.current === null) key.current = await server.vapidPublicKey();
            if (key.current === null) return setState('unsupported');
            const manager = await env.pushManager();
            const sub =
              (await manager.getSubscription()) ??
              (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key.current) }));
            await registerSubscription(sub, server);
            setState('subscribed');
          } finally {
            notifyPushChanged(origin.current);
          }
        });
      } catch {
        setState('failed');
      }
    })();
  }, [env, server, setState]);

  const disable = useCallback(() => {
    setState('pending');
    void serialize(async () => {
      try {
        const sub = await (await env.pushManager()).getSubscription();
        if (knownSubscription !== null) await server.unregister(knownSubscription.id);
        knownSubscription = null;
        if (sub !== null) await sub.unsubscribe();
        setState('default');
      } catch {
        setState('failed');
      } finally {
        notifyPushChanged(origin.current);
      }
    });
  }, [env, server, setState]);

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
