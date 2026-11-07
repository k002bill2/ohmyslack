/** Codex r2 P1 배선: 「답글」로 스레드를 열고 닫으면 DataSource.openThread가 그 root·null로 불린다. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

describe('스레드 열기 배선', () => {
  it('답글 클릭 → openThread(root), 닫기 → openThread(null)', async () => {
    installViewport(1400);
    const user = userEvent.setup();
    const calls: (string | null)[] = [];
    const ds = { ...memory(), openThread: (rootId: string | null) => calls.push(rootId) };
    render(<App dataSource={ds} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    const trigger = document.querySelector<HTMLElement>('[data-reply-for="m1"]');
    if (trigger === null) throw new Error('답글 버튼 없음');
    await user.click(trigger);
    expect(calls.at(-1)).toBe('m1');
    const panel = screen.getByRole('complementary', { name: '스레드' });
    fireEvent.click(within(panel).getByRole('button', { name: '닫기' }));
    expect(calls.at(-1)).toBeNull();
  });
});
