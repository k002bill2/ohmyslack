import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderMenu } from '../../src/features/layout/HeaderMenu.js';
import { PushDialog } from '../../src/features/pwa/PushDialog.js';
import { resetPushMemory, type PushEnv } from '../../src/features/pwa/PushSettings.js';
import { DIALOG_TITLES, HEADER_MENU_COPY, PUSH_SETTINGS_COPY as C } from '../../src/ui/copy.js';

const env: PushEnv = {
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
  standalone: () => false,
  supported: true,
  permission: () => 'default',
  requestPermission: async () => 'default',
  pushManager: async () => ({ getSubscription: async () => null, subscribe: vi.fn() }),
};
const server = { vapidPublicKey: async () => 'BEl62iUY', register: async () => 'id', unregister: async () => undefined };

afterEach(() => {
  cleanup();
  resetPushMemory();
});

describe('Jarvis DM 알림 설정(G-74 — 본문 배너 대신 헤더 더보기 → Dialog)', () => {
  it('헤더 더보기 첫 항목 「알림 설정…」이 onNotifications를 부른다', () => {
    const onNotifications = vi.fn();
    render(<HeaderMenu onNotifications={onNotifications} onShortcuts={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: HEADER_MENU_COPY.more }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.textContent).toContain(HEADER_MENU_COPY.notifications);
    fireEvent.click(items[0] as HTMLElement);
    expect(onNotifications).toHaveBeenCalledOnce();
  });

  it('onNotifications가 없으면 항목이 없다(봇 아닌 대화)', () => {
    render(<HeaderMenu onShortcuts={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: HEADER_MENU_COPY.more }));
    expect(screen.queryByText(HEADER_MENU_COPY.notifications)).toBeNull();
  });

  it('Dialog는 안내 문구와 알림 켜기 카드를 담고 닫기로 닫힌다', async () => {
    const onClose = vi.fn();
    render(<PushDialog env={env} server={server} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: DIALOG_TITLES.notifications })).toBeTruthy();
    expect(screen.getByText(C.botHint)).toBeTruthy();
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
