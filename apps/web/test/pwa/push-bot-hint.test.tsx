import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushBotHint, resetPushBotHint } from '../../src/features/pwa/PushBotHint.js';
import { resetPushMemory, type PushEnv } from '../../src/features/pwa/PushSettings.js';
import { PUSH_SETTINGS_COPY as C } from '../../src/ui/copy.js';

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
  resetPushBotHint();
  resetPushMemory();
});

describe('Jarvis DM 알림 1회 안내(★Q-H4)', () => {
  it('닫으면 같은 탭에서 다시 마운트해도 보이지 않는다(메모리 표시)', async () => {
    render(<PushBotHint env={env} server={server} />);
    expect(screen.getByText(C.botHint)).toBeTruthy();
    expect(await screen.findByRole('button', { name: C.enable })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: C.dismissHint }));
    expect(screen.queryByText(C.botHint)).toBeNull();
    cleanup();
    render(<PushBotHint env={env} server={server} />);
    expect(screen.queryByText(C.botHint)).toBeNull();
  });
});
