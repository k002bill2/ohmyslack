/**
 * menu-bots-touch-focus 항목 2: 터치 기본 기기(`(hover: none) and (pointer: coarse)`)에서는 공간 전환(F4) 뒤
 * 작성기 대신 대화 제목(비텍스트, tabIndex -1)으로 — iOS Safari는 프로그래밍 focus로도 가상 키보드를 띄운다.
 * 마우스·키보드 기기는 그대로 작성기(keyboard.test F4).
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';

afterEach(cleanup);

async function switchSpace(coarse: boolean) {
  installViewport(1280);
  setCoarsePointer(coarse);
  const user = userEvent.setup();
  render(<App dataSource={memory()} />);
  screen.getByRole('button', { name: 'general' }).focus();
  await user.keyboard('{Enter}');
  await user.keyboard('{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}');
}

describe('터치 기기 공간 전환 뒤 자동 포커스', () => {
  it('coarse: 작성기(textarea)가 아니라 새 대화 제목, BODY도 아님', async () => {
    await switchSpace(true);
    const active = document.activeElement as HTMLElement;
    expect(active.tagName).not.toBe('TEXTAREA');
    expect(active).not.toBe(document.body);
    expect(active.className).toContain('conversation-title');
    expect(active.textContent).toContain('dev');
  });

  it('fine: 기존대로 새 공간의 작성기', async () => {
    await switchSpace(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#dev에 메시지 작성' }));
  });
});
