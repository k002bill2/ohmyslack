import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { resetPushMemory, type PushEnv, type PushServerApi } from '../../src/features/pwa';
import type { PushManagerLike, PushSubscriptionLike } from '../../src/features/pwa/PushSettings.js';
import type { DataSource, Snapshot } from '../../src/data';
import { PREFERENCES_COPY } from '../../src/ui/copy.js';
import { memory, seed } from '../helpers/fixtures.js';

// 합성 VAPID 공개키 모양(0x04 + 64바이트, base64url). 실키·고정 리터럴을 두지 않는다(gitleaks generic-api-key).
const KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, i) => i))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Chrome/140 Safari/537.36';
const account = { id: 'u1', displayName: '강영환', role: 'owner' as const };

function fakeSub(boundKey?: ArrayBuffer): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/x',
    ...(boundKey === undefined ? {} : { options: { applicationServerKey: boundKey } }),
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

interface Opts {
  readonly ua?: string;
  readonly standalone?: boolean;
  readonly permission?: NotificationPermission;
  readonly existing?: PushSubscriptionLike | null;
  readonly key?: string | null;
  readonly registerFails?: boolean;
}

/** AppShell을 Dialog 없이 렌더한다 — 앱 진입만으로 재등록되는지 본다. */
function renderShell(opts: Opts = {}) {
  const manager: PushManagerLike = { getSubscription: vi.fn(async () => opts.existing ?? null), subscribe: vi.fn() };
  const env: PushEnv = {
    userAgent: opts.ua ?? DESKTOP_UA,
    standalone: () => opts.standalone ?? false,
    supported: true,
    permission: () => opts.permission ?? 'granted',
    requestPermission: vi.fn(async () => 'granted' as const),
    pushManager: vi.fn(async () => manager),
  };
  const server = {
    vapidPublicKey: vi.fn(async () => (opts.key === undefined ? KEY : opts.key)),
    register: vi.fn(async (_s: unknown): Promise<string> => {
      if (opts.registerFails === true) throw new Error('boom');
      return 'id-1';
    }),
    unregister: vi.fn(async (_id: string) => undefined),
  } satisfies PushServerApi;
  render(<AppShell dataSource={Object.assign(memory({ account }), { push: server })} pushEnv={env} />);
  return { env, server, manager };
}

afterEach(() => {
  cleanup();
  resetPushMemory();
});

describe('앱 진입 시 기존 푸시 구독 조용히 재등록(CMP-30, 환경설정 이동 회귀)', () => {
  it('권한 granted + 기존 구독 → 환경설정 Dialog를 열지 않아도 register 1회', async () => {
    const { env, server } = renderShell({ existing: fakeSub() });
    await waitFor(() => expect(server.register).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: PREFERENCES_COPY.title })).toBeNull();
    expect(env.requestPermission).not.toHaveBeenCalled();
    // 같은 마운트에서 반복하지 않는다.
    await new Promise((r) => setTimeout(r, 20));
    expect(server.register).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Opts]>([
    ['권한 default', { permission: 'default', existing: fakeSub() }],
    ['권한 denied', { permission: 'denied', existing: fakeSub() }],
    ['구독 없음', { existing: null }],
    ['VAPID 없음(push 비활성)', { key: null, existing: fakeSub() }],
    ['iOS 홈 화면 미설치', { ua: IOS_UA, standalone: false, existing: fakeSub() }],
  ])('%s → requestPermission·register 호출 없음', async (_name, opts) => {
    const { env, server } = renderShell(opts);
    await new Promise((r) => setTimeout(r, 20));
    expect(env.requestPermission).not.toHaveBeenCalled();
    expect(server.register).not.toHaveBeenCalled();
  });

  it('키 회전(다른 키에 결속된 구독) → 앱 진입에서 unsubscribe, register 안 함', async () => {
    const existing = fakeSub(new Uint8Array([4, 9, 9, 9]).buffer);
    const { env, server } = renderShell({ existing });
    await waitFor(() => expect(existing.unsubscribe).toHaveBeenCalledTimes(1));
    expect(server.register).not.toHaveBeenCalled();
    expect(env.requestPermission).not.toHaveBeenCalled();
  });

  it('서버 등록 실패는 조용히 무시한다(UI 알림 없음)', async () => {
    const { server } = renderShell({ existing: fakeSub(), registerFails: true });
    await waitFor(() => expect(server.register).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/** 스냅숏을 바꿀 수 있는 데이터 소스 — `/api/me`(CSRF 토큰) 응답 전후의 account 유무를 흉내 낸다. */
function switchableSource(server: PushServerApi) {
  let snapshot: Snapshot = Object.freeze(seed());
  const listeners = new Set<() => void>();
  const source: DataSource & { push: PushServerApi } = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: () => undefined,
    push: server,
  };
  const setAccount = (next: Snapshot['account']) => {
    snapshot = Object.freeze({ ...snapshot, ...(next === undefined ? {} : { account: next }) });
    listeners.forEach((l) => l());
  };
  return { source, setAccount };
}

describe('재등록은 계정(CSRF) 확정 뒤에만(Codex P1-1)', () => {
  it('account 없음 → register 0회, account가 생기면 1회, 다른 계정으로 바뀌면 다시 1회', async () => {
    const manager: PushManagerLike = { getSubscription: vi.fn(async () => fakeSub()), subscribe: vi.fn() };
    const env: PushEnv = {
      userAgent: DESKTOP_UA,
      standalone: () => false,
      supported: true,
      permission: () => 'granted',
      requestPermission: vi.fn(async () => 'granted' as const),
      pushManager: vi.fn(async () => manager),
    };
    const server = {
      vapidPublicKey: vi.fn(async () => KEY),
      register: vi.fn(async (_s: unknown): Promise<string> => 'id-1'),
      unregister: vi.fn(async (_id: string) => undefined),
    } satisfies PushServerApi;
    const { source, setAccount } = switchableSource(server);
    render(<AppShell dataSource={source} pushEnv={env} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.vapidPublicKey).not.toHaveBeenCalled();
    expect(server.register).not.toHaveBeenCalled();

    act(() => setAccount(account));
    await waitFor(() => expect(server.register).toHaveBeenCalledTimes(1));
    // 같은 계정의 스냅숏 갱신(메시지 도착 등)에는 반복하지 않는다.
    act(() => setAccount(account));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.register).toHaveBeenCalledTimes(1);

    act(() => setAccount({ ...account, id: 'u2' }));
    await waitFor(() => expect(server.register).toHaveBeenCalledTimes(2));
  });
});
