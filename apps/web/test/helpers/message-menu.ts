/** R4 메시지 메뉴: 툴바 「더보기」를 눌러 메뉴를 열고 항목을 돌려준다(삭제는 툴바가 아니라 메뉴 안). */
import { fireEvent, screen, within } from '@testing-library/react';

export function openMessageMenu(scope: HTMLElement): HTMLElement {
  fireEvent.click(within(scope).getByRole('button', { name: '더보기' }));
  return screen.getByRole('menu', { name: '메시지 메뉴' });
}

/** 「메시지 삭제…」 메뉴 항목(메뉴를 연다). */
export function deleteMenuItem(scope: HTMLElement): HTMLElement {
  return within(openMessageMenu(scope)).getByRole('menuitem', { name: '메시지 삭제…' });
}
