/** R4 시안 대화 헤더 더보기(Floating-Menus D): 키보드 단축키 · 채널 나가기…(채널만). 기대값은 리터럴. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

async function enter(width: number, spaceName: string) {
  installViewport(width);
  const user = userEvent.setup();
  render(<AppShell dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: spaceName }));
  return user;
}

const menuNames = () => within(screen.getByRole('menu', { name: '대화 메뉴' })).getAllByRole('menuitem').map((b) => b.textContent);

describe('대화 헤더 더보기', () => {
  it('wide 채널: 「키보드 단축키」 → 단축키 안내 Dialog, 닫으면 포커스는 더보기 버튼', async () => {
    const user = await enter(1440, 'general');
    const more = screen.getByRole('button', { name: '대화 더보기' });
    await user.click(more);
    expect(menuNames()[0]).toBe('키보드 단축키');
    await user.click(screen.getByRole('menuitem', { name: '키보드 단축키' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('DM에는 「채널 나가기…」가 없다', async () => {
    const user = await enter(1440, '홍길동');
    await user.click(screen.getByRole('button', { name: '대화 더보기' }));
    expect(menuNames()).toEqual(['키보드 단축키']);
  });

  it('compact는 단축키 항목이 없어 메뉴 버튼 자체를 그리지 않는다(메모리 소스는 나가기 없음)', async () => {
    await enter(390, 'general');
    expect(screen.queryByRole('button', { name: '대화 더보기' })).toBeNull();
  });
});
