import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { PreferencesDialog, type PreferencesSection } from '../../src/features/preferences';
import { resetPushMemory, type PushEnv } from '../../src/features/pwa';
import { PushSettings } from '../../src/features/pwa';
import { Sidebar } from '../../src/features/sidebar';
import { DIALOG_CLOSE_LABEL, PREFERENCES_COPY as P, PUSH_SETTINGS_COPY } from '../../src/ui/copy.js';
import { breakpoints } from '../../src/ui/tokens.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(() => {
  cleanup();
  resetPushMemory();
});

const env: PushEnv = {
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
  standalone: () => false,
  supported: true,
  permission: () => 'default',
  requestPermission: async () => 'default',
  pushManager: async () => ({ getSubscription: async () => null, subscribe: vi.fn() }),
};
const server = { vapidPublicKey: async () => 'BEl62iUY', register: async () => 'id', unregister: async () => undefined };
const account = { id: 'u1', displayName: '강영환', role: 'owner' as const };

const notifications: PreferencesSection = {
  id: 'notifications',
  label: P.sections.notifications,
  description: P.notificationsDescription,
  content: <PushSettings env={env} server={server} />,
};
/** 가짜 섹션 — 배열 항목 하나 추가로 목록·전환·tabpanel 연결이 늘어나는지 증명. */
const fake: PreferencesSection = { id: 'fake', label: '가짜 섹션', content: <p>가짜 내용</p> };

/** 설정 아이콘(트리거) → Dialog. 닫으면 언마운트(포커스 복귀 확인용). */
function Harness({ sections }: { readonly sections: readonly PreferencesSection[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Sidebar spaces={[]} selectedId={null} collapsed={false} onSelect={() => {}} account={account} onOpenPreferences={() => setOpen(true)} />
      {open && <PreferencesDialog sections={sections} onClose={() => setOpen(false)} />}
    </>
  );
}

describe('PreferencesDialog(환경설정 — 섹션 배열 구조)', () => {
  it('섹션 1개여도 세로 tablist를 보이고 「알림」 패널에 PushSettings가 그대로 렌더된다', async () => {
    render(<PreferencesDialog sections={[notifications]} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: P.title });
    const list = within(dialog).getByRole('tablist', { name: P.sectionsLabel });
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    const tab = within(list).getByRole('tab', { name: P.sections.notifications });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const panel = within(dialog).getByRole('tabpanel', { name: P.sections.notifications });
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(within(panel).getByRole('heading', { level: 3, name: P.sections.notifications })).toBeTruthy();
    expect(within(panel).getByText(P.notificationsDescription)).toBeTruthy();
    expect(await within(panel).findByRole('button', { name: PUSH_SETTINGS_COPY.enable })).toBeTruthy();
  });

  it('가짜 섹션을 하나 더 넣으면 목록 2개, 클릭·화살표로 전환되고 tabpanel이 선택 탭과 연결된다', () => {
    render(<PreferencesDialog sections={[notifications, fake]} onClose={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([P.sections.notifications, '가짜 섹션']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);

    fireEvent.click(tabs[1] as HTMLElement);
    let panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1]?.id);
    expect(within(panel).getByText('가짜 내용')).toBeTruthy();

    fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'ArrowDown' }); // 끝에서 처음으로 순환
    expect(document.activeElement).toBe(tabs[0]);
    panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(tabs[1]);
  });

  it('키보드: 설정 아이콘 Enter로 열리고, 화살표로 섹션 이동, Esc로 닫혀 설정 아이콘으로 포커스가 돌아간다', async () => {
    const user = userEvent.setup();
    render(<Harness sections={[notifications, fake]} />);
    const trigger = screen.getByRole('button', { name: P.open });
    expect(trigger.getAttribute('title')).toBe(P.open);
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: P.title })).toBeTruthy();
    const first = screen.getByRole('tab', { name: P.sections.notifications });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '가짜 섹션' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('닫기 버튼으로도 닫힌다', () => {
    const onClose = vi.fn();
    render(<PreferencesDialog sections={[fake]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: DIALOG_CLOSE_LABEL }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('포커스 트랩 × roving tabindex(Codex P1-2)', () => {
  const textOnly = (id: string, label: string): PreferencesSection => ({ id, label, content: <p>{label} 내용</p> });

  it.each([0, 1])('섹션 2개(포커스 가능한 내용 없음, %i번 선택) — Tab/Shift+Tab이 닫기·선택 탭·패널만 돌고 비선택 탭으로 가지 않는다', async (selected) => {
    const user = userEvent.setup();
    const sections = [textOnly('a', '섹션 가'), textOnly('b', '섹션 나')];
    render(<PreferencesDialog sections={sections} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: P.title });
    const close = within(dialog).getByRole('button', { name: DIALOG_CLOSE_LABEL });
    const tabs = within(dialog).getAllByRole('tab');
    if (selected === 1) fireEvent.click(tabs[1]!);
    const active = tabs[selected]!;
    const inactive = tabs[1 - selected]!;
    const panel = within(dialog).getByRole('tabpanel');
    expect(panel.tabIndex).toBe(0);

    close.focus();
    const forward: Element[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      forward.push(document.activeElement!);
    }
    expect(forward).toEqual([active, panel, close, active]);

    close.focus();
    const backward: Element[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab({ shift: true });
      backward.push(document.activeElement!);
    }
    expect(backward).toEqual([panel, active, close, panel]);
    expect([...forward, ...backward]).not.toContain(inactive);
  });
});

describe('사이드바 설정 아이콘', () => {
  it('순서: 멤버 관리 → 세션 → 환경설정 → 로그아웃, 계정 카드 아래 알림 카드는 없다', () => {
    const { container } = render(
      <Sidebar spaces={[]} selectedId={null} collapsed={false} onSelect={() => {}} account={account}
        onManageMembers={() => {}} onManageSessions={() => {}} onOpenPreferences={() => {}} onLogout={() => {}} />,
    );
    const card = container.querySelector('.account-card') as HTMLElement;
    const labels = within(card).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf(P.open)).toBe(labels.length - 2);
    expect(container.querySelector('.sidebar-account')?.children.length).toBe(1);
  });

  it('접힌 사이드바에서도 보이고, onOpenPreferences가 없으면 숨는다', () => {
    const { rerender } = render(<Sidebar spaces={[]} selectedId={null} collapsed onSelect={() => {}} account={account} onOpenPreferences={() => {}} />);
    expect(screen.getByRole('button', { name: P.open })).toBeTruthy();
    rerender(<Sidebar spaces={[]} selectedId={null} collapsed onSelect={() => {}} account={account} />);
    expect(screen.queryByRole('button', { name: P.open })).toBeNull();
  });
});

describe('AppShell 환경설정 배선', () => {
  it('push가 없으면(섹션 0개) 설정 아이콘을 숨긴다', async () => {
    installViewport(1280);
    render(<App dataSource={memory({ account })} />);
    await screen.findByText(account.displayName);
    await screen.findByRole('navigation', { name: '공간' });
    expect(screen.queryByRole('button', { name: P.open })).toBeNull();
  });

  it.each([
    ['wide', 1280],
    ['compact', breakpoints.compactMax],
  ])('%s: push가 있으면 설정 아이콘 → 「환경설정」 Dialog의 「알림」 섹션', async (_name, width) => {
    installViewport(width);
    const user = userEvent.setup();
    render(<App dataSource={Object.assign(memory({ account }), { push: server })} />);
    const trigger = await screen.findByRole('button', { name: P.open });
    await act(async () => {
      await user.click(trigger);
    });
    const dialog = screen.getByRole('dialog', { name: P.title });
    expect(within(dialog).getByRole('tab', { name: P.sections.notifications }).getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByRole('tabpanel', { name: P.sections.notifications })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('preferences.css', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/features/preferences/preferences.css'), 'utf8');
  it('Dialog(elevated 면) 위 탭 hover는 --bg-hover-strong, 탭 44px, compact는 가로 스크롤 줄', () => {
    expect(css).toMatch(/\.preferences-tab:hover \{\s*background: var\(--bg-hover-strong\)/);
    expect(css).toContain('min-block-size: 44px');
    const compact = css.slice(css.indexOf('@media (width <= 640px)'));
    expect(compact).toContain('flex-direction: row');
    expect(compact).toContain('overflow-x: auto');
    expect(css).toContain('white-space: nowrap');
  });
});
