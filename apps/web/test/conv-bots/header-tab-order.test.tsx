/**
 * a11y-focus-order 항목 1(WCAG 2.4.3 포커스 순서) + menu-bots-touch-focus: 봇 추가·제거는 「대화 더보기」 메뉴 항목.
 * 머리에는 봇 버튼이 없다 → Tab은 뒤로 → 메뉴(채널명은 포커스 대상 아님) 한 줄. 메뉴 순서: 단축키 → 봇 항목 → 채널 나가기….
 * 봇 제거 확인 Dialog가 닫히면 포커스는 「…」로 돌아온다(MessageMenu returnFocus → Dialog 복귀 대상).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import type { Member } from '../../src/data';
import { BOT_CHANNEL_COPY, HEADER_MENU_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';
import { BOT, OWNER, PEER, fakeBotWorld } from './fake-bots.js';
import { headerMenuItems, selectHeaderMenuItem } from './header-menu.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};
const BOT_B = { id: 'u-bot-b', displayName: '알림 봇', role: 'member', kind: 'bot' } as const satisfies Member;

/** 봇 2개(Jarvis는 채널에 참여 중, 알림 봇은 아님) owner 채널. */
async function openGeneral(width: number) {
  installViewport(width);
  const w = fakeBotWorld('owner');
  w.members.get('c1')?.add(BOT.id);
  const directory: readonly Member[] = [{ ...OWNER, role: 'owner' }, PEER, BOT, BOT_B];
  const ds = { ...w.ds, listMembers: () => Promise.resolve({ ok: true as const, value: directory }) };
  render(<AppShell dataSource={ds} />);
  await settle();
  fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
  await settle();
  const header = document.querySelector<HTMLElement>('.conversation-header');
  if (header === null) throw new Error('머리 없음');
  return { w, header };
}

const label = (el: Element | null) => (el === null ? null : (el.getAttribute('aria-label') ?? el.textContent));

describe('채널 머리 Tab 순서 = 화면 순서', () => {
  it('390: 머리에 봇 버튼이 없고 Tab은 뒤로 → 메뉴 다음 머리를 벗어난다', async () => {
    const { header } = await openGeneral(390);
    expect(header.querySelector('.bot-channel-control')).toBeNull();
    expect(within(header).queryByRole('button', { name: BOT_CHANNEL_COPY.title(BOT.displayName) })).toBeNull();
    const user = userEvent.setup();
    within(header).getByRole('button', { name: '뒤로' }).focus();
    await user.tab();
    expect(label(document.activeElement)).toBe(HEADER_MENU_COPY.more);
    await user.tab();
    expect(header.contains(document.activeElement)).toBe(false);
  });

  it('1440: 메뉴 = 단축키 → (구분선) 봇 제거: A · 봇 추가: B → (구분선) 채널 나가기…', async () => {
    await openGeneral(1440);
    expect(headerMenuItems()).toEqual([
      HEADER_MENU_COPY.shortcuts,
      BOT_CHANNEL_COPY.title(BOT.displayName),
      BOT_CHANNEL_COPY.add(BOT_B.displayName),
      HEADER_MENU_COPY.leave,
    ]);
    fireEvent.click(screen.getByRole('button', { name: HEADER_MENU_COPY.more }));
    const menu = screen.getByRole('menu', { name: HEADER_MENU_COPY.menu });
    expect(within(menu).getAllByRole('separator')).toHaveLength(2);
    // 봇 제거는 danger 아님(확인 Dialog가 있다) — 채널 나가기만 danger.
    expect(within(menu).getByRole('menuitem', { name: BOT_CHANNEL_COPY.title(BOT.displayName) }).className).not.toContain('danger');
  });

  it('봇 제거 → 확인 Dialog → 성공 뒤 메뉴 항목이 「봇 추가: A」로, Dialog가 닫히면 포커스는 「…」', async () => {
    const { w } = await openGeneral(1440);
    selectHeaderMenuItem(BOT_CHANNEL_COPY.title(BOT.displayName));
    const trigger = screen.getByRole('button', { name: HEADER_MENU_COPY.more });
    const dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    expect(w.calls).toEqual([`DELETE /api/conversations/c1/bots/${BOT.id}`]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(headerMenuItems()).toEqual([
      HEADER_MENU_COPY.shortcuts,
      BOT_CHANNEL_COPY.add(BOT.displayName),
      BOT_CHANNEL_COPY.add(BOT_B.displayName),
      HEADER_MENU_COPY.leave,
    ]);
  });

  it('취소로 닫아도 포커스는 「…」', async () => {
    await openGeneral(1440);
    selectHeaderMenuItem(BOT_CHANNEL_COPY.title(BOT.displayName));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: HEADER_MENU_COPY.more }));
  });

  it('Codex r1 P1: 제거 확인창을 연 채 다른 채널로 가면 확인 상태가 버려진다(다른 채널 봇을 지우지 않음)', async () => {
    const { w } = await openGeneral(1440);
    w.members.get('c2')?.add(BOT.id);
    selectHeaderMenuItem(BOT_CHANNEL_COPY.title(BOT.displayName));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 확인창이 앱을 inert로 만든다 — 브라우저 뒤로가기처럼 확인창 밖에서 일어난 전환을 흉내 낸다.
    const nav = screen.getByRole('navigation', { name: '공간', hidden: true });
    fireEvent.click(within(nav).getByRole('button', { name: /^dev/, hidden: true }));
    await settle();
    expect(document.querySelector('.conversation-title')?.textContent).toContain('dev');
    const stale = screen.queryByRole('dialog');
    if (stale !== null) fireEvent.click(within(stale).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(w.calls).toEqual([]);
  });
});
