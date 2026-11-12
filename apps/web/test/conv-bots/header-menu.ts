/** menu-bots-touch-focus: 봇 추가·제거는 머리 「대화 더보기」 메뉴 항목 — 테스트가 메뉴를 열어 항목을 읽고 고른다. */
import { fireEvent, screen, within } from '@testing-library/react';
import { HEADER_MENU_COPY } from '../../src/ui/copy.js';

/** 메뉴 항목 이름(열었다가 Escape로 닫는다). 메뉴 버튼이 없으면 빈 목록. */
export function headerMenuItems(): string[] {
  const trigger = screen.queryByRole('button', { name: HEADER_MENU_COPY.more });
  if (trigger === null) return [];
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: HEADER_MENU_COPY.menu });
  const names = within(menu).queryAllByRole('menuitem').map((m) => m.textContent ?? '');
  fireEvent.keyDown(menu, { key: 'Escape' });
  return names;
}

/** 메뉴를 열고 이름이 `name`인 항목을 고른다. */
export function selectHeaderMenuItem(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: HEADER_MENU_COPY.more }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}
