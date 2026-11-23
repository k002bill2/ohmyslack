import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  base64UrlToBytes,
  PushSettings,
  resetPushMemory,
  type PushEnv,
  type PushManagerLike,
  type PushServerApi,
  type PushSubscriptionLike,
} from '../../src/features/pwa/PushSettings.js';
import { INSTALL_COPY, PUSH_SETTINGS_COPY as C } from '../../src/ui/copy.js';

// 합성 VAPID 공개키 모양(0x04 + 64바이트, base64url). 실키·고정 리터럴을 두지 않는다(gitleaks generic-api-key).
const KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, i) => i))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SUB_ID = '44444444-4444-4444-8444-444444444444';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Chrome/140 Safari/537.36';

function fakeSub(): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/x',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setup(opts: { ua?: string; standalone?: boolean; supported?: boolean; permission?: NotificationPermission; existing?: PushSubscriptionLike | null; key?: string | null } = {}) {
  let permission: NotificationPermission = opts.permission ?? 'default';
  let current: PushSubscriptionLike | null = opts.existing ?? null;
  const sub = fakeSub();
  const manager: PushManagerLike & { subscribe: ReturnType<typeof vi.fn> } = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = sub;
      return sub;
    }),
  };
  const calls: string[] = [];
  const env: PushEnv = {
    userAgent: opts.ua ?? DESKTOP_UA,
    standalone: () => opts.standalone ?? false,
    supported: opts.supported ?? true,
    permission: () => permission,
    requestPermission: vi.fn(async () => {
      calls.push('requestPermission');
      permission = 'granted';
      return permission;
    }),
    pushManager: vi.fn(async () => manager),
  };
  const server = {
    vapidPublicKey: vi.fn(async () => (opts.key === undefined ? KEY : opts.key)),
    register: vi.fn(async (_s: unknown) => {
      calls.push('register');
      return SUB_ID;
    }),
    unregister: vi.fn(async (_id: string) => {
      calls.push('unregister');
    }),
  } satisfies PushServerApi;
  render(<PushSettings env={env} server={server} />);
  return { env, server, manager, sub, calls, setPermission: (p: NotificationPermission) => (permission = p) };
}

afterEach(() => {
  cleanup();
  resetPushMemory();
});

describe('CMP-30 PushSettings 상태(UI_STATES §2-10)', () => {
  it('Codex r1 P2: 이미 구독된 기기는 마운트마다 서버에 다시 등록한다(새 세션 결속)', async () => {
    const existing = fakeSub();
    const first = setup({ permission: 'granted', existing });
    expect(await screen.findByText(C.subscribed)).toBeTruthy();
    cleanup();
    const second = setup({ permission: 'granted', existing });
    expect(await screen.findByText(C.subscribed)).toBeTruthy();
    expect(first.server.register).toHaveBeenCalledTimes(1);
    expect(second.server.register).toHaveBeenCalledTimes(1);
  });

  it('Codex r1 P2: 기존 구독이 다른 VAPID 키에 결속돼 있으면 해제하고 알림 켜기로 돌아간다(키 회전)', async () => {
    const existing = { ...fakeSub(), options: { applicationServerKey: new Uint8Array(65).fill(9).buffer } };
    const { server } = setup({ permission: 'granted', existing });
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(server.register).not.toHaveBeenCalled();
  });

  it('미지원: PushManager 등이 없으면 안내만', async () => {
    setup({ supported: false });
    expect(await screen.findByText(C.unsupported)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('미지원: 서버 VAPID 공개 키 404(null)', async () => {
    const { server } = setup({ key: null });
    expect(await screen.findByText(C.unsupported)).toBeTruthy();
    expect(server.vapidPublicKey).toHaveBeenCalledTimes(1);
  });

  it('홈 화면 미설치(iOS): PushManager 판정보다 먼저, 설치 안내(CMP-20) 열기', async () => {
    const { server } = setup({ ua: IOS_UA, supported: false });
    expect(await screen.findByText(C.iosInstall)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: C.openInstallHint }));
    expect(screen.getByText(INSTALL_COPY.ios)).toBeTruthy();
    expect(server.vapidPublicKey).not.toHaveBeenCalled();
  });

  it('iOS standalone이면 홈 화면 안내 없이 권한 미결정', async () => {
    setup({ ua: IOS_UA, standalone: true });
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
  });

  it('거부됨: 시스템 설정 안내만', async () => {
    setup({ permission: 'denied' });
    expect(await screen.findByText(C.denied)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('권한 미결정 → 「알림 켜기」: 클릭 안에서 requestPermission을 네트워크보다 먼저 동기 호출 → subscribe → POST → 구독됨', async () => {
    const { env, server, manager, calls } = setup();
    const button = await screen.findByRole('button', { name: C.enable });
    await waitFor(() => expect(server.vapidPublicKey).toHaveBeenCalled());
    fireEvent.click(button);
    // await 전(동기): 권한 요청은 이미 호출, 서버 등록은 아직.
    expect(env.requestPermission).toHaveBeenCalledTimes(1);
    expect(server.register).not.toHaveBeenCalled();
    expect(await screen.findByText(C.subscribed)).toBeTruthy();
    expect(calls).toEqual(['requestPermission', 'register']);
    const opts = manager.subscribe.mock.calls[0]?.[0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...base64UrlToBytes(KEY)]);
    expect(opts.applicationServerKey.length).toBe(65);
    expect(server.register).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }));
  });

  it('권한 요청에서 거부하면 거부됨', async () => {
    const { env } = setup();
    vi.mocked(env.requestPermission).mockResolvedValueOnce('denied');
    fireEvent.click(await screen.findByRole('button', { name: C.enable }));
    expect(await screen.findByText(C.denied)).toBeTruthy();
  });

  it('구독됨: 이미 구독돼 있고 id를 모르면 upsert POST로 id를 받고, 끄기 → DELETE 후 unsubscribe', async () => {
    const existing = fakeSub();
    const { server, calls } = setup({ permission: 'granted', existing });
    expect(await screen.findByText(C.subscribed)).toBeTruthy();
    expect(server.register).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: C.disable }));
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
    expect(server.unregister).toHaveBeenCalledWith(SUB_ID);
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['register', 'unregister']);
    expect(server.unregister.mock.invocationCallOrder[0]).toBeLessThan(existing.unsubscribe.mock.invocationCallOrder[0] ?? 0);
  });

  it('권한 허용인데 구독이 없으면 권한 미결정처럼 「알림 켜기」', async () => {
    setup({ permission: 'granted' });
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
  });

  it('등록 실패(서버 4xx·5xx) → 오류 + 「다시 시도」 → 성공하면 구독됨', async () => {
    const { server } = setup();
    server.register.mockRejectedValueOnce(new Error('500'));
    fireEvent.click(await screen.findByRole('button', { name: C.enable }));
    expect(await screen.findByText(C.failed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: C.retry }));
    expect(await screen.findByText(C.subscribed)).toBeTruthy();
    expect(server.register).toHaveBeenCalledTimes(2);
  });

  it('VAPID 키 조회가 네트워크 오류면 등록 실패', async () => {
    const { server } = setup();
    // 첫 인스턴스의 재동기화(직렬화 체인 — 마이크로태스크 뒤 실행)가 끝난 뒤에 실패를 건다.
    await screen.findByRole('button', { name: C.enable });
    server.vapidPublicKey.mockRejectedValueOnce(new Error('network'));
    cleanup();
    render(<PushSettings env={{ userAgent: DESKTOP_UA, standalone: () => false, supported: true, permission: () => 'default', requestPermission: async () => 'default', pushManager: async () => ({ getSubscription: async () => null, subscribe: async () => fakeSub() }) }} server={server} />);
    expect(await screen.findByText(C.failed)).toBeTruthy();
  });
});

describe('구독 변경 직렬화(Codex P1-3) — 끄기 진행 중 닫고 다시 열기', () => {
  it('DELETE 지연 중 언마운트 → 재마운트 → 지연 해제: 새 화면은 실제 상태(알림 켜기)이고 DELETE 뒤 register가 다시 나가지 않는다', async () => {
    const calls: string[] = [];
    let current: PushSubscriptionLike | null = null;
    const sub: PushSubscriptionLike = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(async () => {
        calls.push('unsubscribe');
        current = null;
        return true;
      }),
    };
    current = sub;
    const manager: PushManagerLike = { getSubscription: vi.fn(async () => current), subscribe: vi.fn() };
    const env: PushEnv = {
      userAgent: DESKTOP_UA,
      standalone: () => false,
      supported: true,
      permission: () => 'granted',
      requestPermission: vi.fn(async () => 'granted' as const),
      pushManager: vi.fn(async () => manager),
    };
    let releaseDelete: () => void = () => undefined;
    const server = {
      vapidPublicKey: vi.fn(async () => KEY),
      register: vi.fn(async (_s: unknown) => {
        calls.push('register');
        return SUB_ID;
      }),
      unregister: vi.fn(async (_id: string) => {
        calls.push('unregister:start');
        await new Promise<void>((resolve) => (releaseDelete = resolve));
        calls.push('unregister:end');
      }),
    } satisfies PushServerApi;

    const first = render(<PushSettings env={env} server={server} />);
    fireEvent.click(await screen.findByRole('button', { name: C.disable }));
    await waitFor(() => expect(server.unregister).toHaveBeenCalledTimes(1));
    first.unmount(); // Dialog 닫기 — 막지 않는다.

    render(<PushSettings env={env} server={server} />);
    await new Promise((r) => setTimeout(r, 20));
    releaseDelete();

    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
    expect(screen.queryByText(C.subscribed)).toBeNull();
    expect(current).toBeNull();
    expect(calls).toEqual(['register', 'unregister:start', 'unregister:end', 'unsubscribe']);
  });
});
