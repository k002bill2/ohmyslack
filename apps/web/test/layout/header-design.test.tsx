/**
 * W-11a 시안 01: 대화 헤더 = 이름 + 보조 「채널」 + (wide·스레드 열림) 스레드 패널 토글. 토글은 닫기 동작이고 F1 포커스 복귀 규칙을 따른다.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

async function openThread(width: number) {
  installViewport(width);
  const user = userEvent.setup();
  render(<App dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  const trigger = document.querySelector<HTMLElement>('[data-reply-for="m1"]');
  if (trigger === null) throw new Error('답글 버튼 없음');
  return { user, trigger };
}

describe('대화 헤더(시안 01)', () => {
  it('이름 옆 보조 줄 「채널」', async () => {
    await openThread(1440);
    const header = screen.getByRole('main').querySelector('header');
    expect(header?.querySelector('.conversation-meta')?.textContent).toBe('채널');
  });

  it('wide: 스레드가 열렸을 때만 패널 토글, 누르면 닫히고 답글 버튼으로 포커스 복귀', async () => {
    const { user, trigger } = await openThread(1440);
    const main = screen.getByRole('main');
    expect(within(main).queryByRole('button', { name: '스레드 패널 닫기' })).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole('complementary', { name: '스레드' })).toBeTruthy();
    await user.click(within(main).getByRole('button', { name: '스레드 패널 닫기' }));
    expect(screen.queryByRole('complementary', { name: '스레드' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('medium: 시트가 열려도 헤더 토글은 렌더하지 않는다(대화 영역은 inert)', async () => {
    const { user, trigger } = await openThread(834);
    await user.click(trigger);
    expect(screen.queryByRole('button', { name: '스레드 패널 닫기' })).toBeNull();
  });
});
