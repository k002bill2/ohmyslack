/**
 * a11y-focus-order 항목 1(WCAG 2.4.3 포커스 순서): 채널 머리 Tab 순서 = 화면 순서.
 * 390: 첫 줄 뒤로·채널명·메뉴, 둘째 줄 봇 버튼 → Tab은 뒤로 → 메뉴 → 봇.
 * 834·1440: 시각 배치를 DOM 순서(메뉴 → 봇)로 맞췄다(layout.css에 order 재배치 없음 — bot-control-narrow 계약).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { BOT_CHANNEL_COPY, HEADER_MENU_COPY } from '../../src/ui/copy.js';
import { installViewport } from '../helpers/viewport.js';
import { BOT, fakeBotWorld } from './fake-bots.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};

async function headerAt(width: number) {
  installViewport(width);
  const w = fakeBotWorld('owner');
  render(<AppShell dataSource={w.ds} />);
  await settle();
  fireEvent.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
  await settle();
  const header = document.querySelector<HTMLElement>('.conversation-header');
  if (header === null) throw new Error('머리 없음');
  return header;
}

const label = (el: Element | null) => (el === null ? null : (el.getAttribute('aria-label') ?? el.textContent));

describe('채널 머리 Tab 순서 = 화면 순서', () => {
  it('390: 뒤로 → 메뉴 → 봇 버튼', async () => {
    const header = await headerAt(390);
    const user = userEvent.setup();
    within(header).getByRole('button', { name: '뒤로' }).focus();
    await user.tab();
    expect(label(document.activeElement)).toBe(HEADER_MENU_COPY.more);
    await user.tab();
    expect(label(document.activeElement)).toBe(BOT_CHANNEL_COPY.add(BOT.displayName));
  });

  it.each([834, 1440])('%i: 머리 DOM(=Tab) 순서는 채널명 → 메뉴 → 봇 컨트롤', async (width) => {
    const header = await headerAt(width);
    const kids = [...header.children].map((c) => c.className.split(' ')[0]);
    expect(kids.indexOf('header-menu')).toBeLessThan(kids.indexOf('bot-channel-control'));
    expect(kids.indexOf('conversation-heading')).toBeLessThan(kids.indexOf('header-menu'));
  });
});
