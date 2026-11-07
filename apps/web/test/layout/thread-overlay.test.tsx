import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

async function openMediumThread() {
  installViewport(800);
  const user = userEvent.setup();
  render(<App dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  const trigger = document.querySelector<HTMLElement>('[data-reply-for="m1"]');
  if (trigger === null) throw new Error('답글 버튼 없음');
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '스레드' });
  return {
    user,
    trigger,
    dialog,
    close: within(dialog).getByRole('button', { name: '닫기' }),
    textbox: within(dialog).getByRole('textbox', { name: '답글 작성' }),
  };
}

describe('medium 스레드 오버레이 포커스 트랩(디자인 §7-3, WCAG 2.1.2)', () => {
  it('Tab은 마지막에서 첫 요소로, Shift+Tab은 첫 요소에서 마지막으로 순환해 오버레이 밖으로 나가지 않는다', async () => {
    const { user, dialog, close, textbox } = await openMediumThread();
    expect(document.activeElement).toBe(textbox);
    // 입력 없음 → 전송 버튼 disabled → 마지막 포커스 가능 요소는 작성기.
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(textbox);

    // 입력 있음 → 전송 버튼이 마지막.
    await user.type(textbox, '초안');
    await user.tab();
    const send = within(dialog).getByRole('button', { name: '전송' });
    expect(document.activeElement).toBe(send);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(send);
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('Esc는 오버레이를 닫고 「답글」 트리거로 포커스를 돌려주며, 조합 중 Esc는 무시한다', async () => {
    const { user, trigger, textbox } = await openMediumThread();
    fireEvent.keyDown(textbox, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog', { name: '스레드' })).toBeTruthy();
    fireEvent.keyDown(textbox, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('dialog', { name: '스레드' })).toBeTruthy();
    fireEvent.keyDown(textbox, { key: 'Process', keyCode: 229 });
    expect(screen.getByRole('dialog', { name: '스레드' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '스레드' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
