/**
 * D §7-3 공간 전환기(`Ctrl/⌘+K`, 기본 전환 수단)·단축키 안내(`Ctrl/⌘+/`)·메시지 목록 roving tabindex(W-16 QA F-1).
 * 문구 정본: copy.ts `SPACE_SWITCHER_COPY`(COPY_GAPS G-33)·`DIALOG_TITLES.shortcuts`(G-26)·`SHORTCUT_ROWS`(D §7-3).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { SHORTCUT_ROWS, SPACE_SWITCHER_COPY } from '../../src/ui/copy.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

function current(): string | null {
  return screen.getByRole('navigation', { name: '공간' }).querySelector('[aria-current="page"] .space-name')?.textContent ?? null;
}

async function openGeneral(width: number) {
  installViewport(width);
  const user = userEvent.setup();
  render(<App dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  return user;
}

describe('FR-CLIENT-01 공간 전환기 Ctrl/⌘+K', () => {
  it('wide·medium에서 Ctrl+K·⌘+K가 어디서든(body 포함) 전환기를 열고, 입력으로 걸러 Enter로 고르면 새 공간의 작성기로 간다', async () => {
    for (const [width, chord] of [
      [1280, '{Control>}k{/Control}'],
      [800, '{Meta>}k{/Meta}'],
    ] as const) {
      const user = await openGeneral(width);
      (document.activeElement as HTMLElement | null)?.blur();
      await user.keyboard(chord);
      const dialog = screen.getByRole('dialog', { name: SPACE_SWITCHER_COPY.title });
      const input = within(dialog).getByRole('combobox', { name: SPACE_SWITCHER_COPY.inputLabel });
      expect(document.activeElement).toBe(input);
      await user.keyboard('de');
      const options = within(dialog).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['#dev']);
      expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
      await user.keyboard('{Enter}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(current()).toBe('dev');
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#dev에 메시지 작성' }));
      cleanup();
    }
  });

  it('↑/↓로 후보를 옮기고, 이미 열린 공간을 골라도 작성기로 간다', async () => {
    const user = await openGeneral(1280);
    screen.getByRole('button', { name: 'general' }).focus();
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox', { name: SPACE_SWITCHER_COPY.inputLabel });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['#general', '#dev', '홍길동']);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id);
    await user.keyboard('{Enter}');
    expect(current()).toBe('general');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#general에 메시지 작성' }));
  });

  it('일치 없음 문구, Esc는 닫고 트리거로 포커스 복귀', async () => {
    const user = await openGeneral(1280);
    const trigger = screen.getByRole('button', { name: 'general' });
    trigger.focus();
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('zzz');
    expect(screen.getByText(SPACE_SWITCHER_COPY.empty)).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: SPACE_SWITCHER_COPY.title })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('IME 조합 중 Enter는 고르지 않는다', async () => {
    const user = await openGeneral(1280);
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox', { name: SPACE_SWITCHER_COPY.inputLabel });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    expect(screen.getByRole('dialog', { name: SPACE_SWITCHER_COPY.title })).toBeTruthy();
  });

  it('한글 확정 직후 Enter(compositionend 뒤 isComposing=false)는 고르지 않고, 조합 중 Tab은 Dialog로 새지 않는다(D §7-4)', async () => {
    const user = await openGeneral(1280);
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox', { name: SPACE_SWITCHER_COPY.inputLabel });
    fireEvent.compositionStart(input);
    const tab = fireEvent.keyDown(input, { key: 'Tab', keyCode: 229, isComposing: true });
    expect(tab).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: SPACE_SWITCHER_COPY.title })).toBeTruthy();
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Dialog가 열린 동안 Ctrl+Alt+↑/↓는 배경 공간을 바꾸지 않고, 수정키 있는 화살표는 후보도 옮기지 않는다', async () => {
    const user = await openGeneral(1280);
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox', { name: SPACE_SWITCHER_COPY.inputLabel });
    const first = input.getAttribute('aria-activedescendant');
    await user.keyboard('{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}');
    expect(current()).toBe('general');
    expect(input.getAttribute('aria-activedescendant')).toBe(first);
    expect(screen.getByRole('dialog', { name: SPACE_SWITCHER_COPY.title })).toBeTruthy();
  });

  it('↓로 옮긴 후보는 목록 안에서 보이게 스크롤한다(APG combobox)', async () => {
    const user = await openGeneral(1280);
    const calls: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(this.textContent ?? '');
    };
    try {
      await user.keyboard('{Control>}k{/Control}');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(calls.at(-1)).toBe('홍길동');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('compact와 다른 Dialog가 열린 동안에는 열지 않는다', async () => {
    installViewport(390);
    const user = userEvent.setup();
    render(<App dataSource={memory()} />);
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    const wide = await openGeneral(1280);
    await wide.keyboard('{Control>}/{/Control}');
    await wide.keyboard('{Control>}k{/Control}');
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-labelledby') && d.textContent?.slice(0, 7))).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: SPACE_SWITCHER_COPY.title })).toBeNull();
  });
});

describe('FR-CLIENT-01 단축키 안내 Ctrl/⌘+/', () => {
  it('정본 키맵 행을 보여 주고 Esc로 닫으면 트리거로 돌아간다', async () => {
    const user = await openGeneral(1280);
    const composer = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
    composer.focus();
    await user.keyboard('{Control>}/{/Control}');
    const dialog = screen.getByRole('dialog', { name: '키보드 단축키' });
    for (const row of SHORTCUT_ROWS) {
      expect(within(dialog).getByText(row.keys)).toBeTruthy();
      expect(within(dialog).getByText(row.action)).toBeTruthy();
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(composer);
  });
});

describe('FR-CLIENT-01 메시지 목록 roving tabindex', () => {
  it('목록은 Tab 정류장 하나(기본: 마지막 메시지), ↑/↓/Home/End로 메시지 단위 이동, R로 그 메시지 답글', async () => {
    const user = await openGeneral(1280);
    const list = document.querySelector('.message-list') as HTMLElement;
    const items = () => [...list.querySelectorAll<HTMLElement>('li[data-message-id]')];
    expect(items().filter((li) => li.tabIndex === 0).map((li) => li.dataset['messageId'])).toEqual(['m2']);
    (items()[1] as HTMLElement).focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items()[0]);
    expect(items().filter((li) => li.tabIndex === 0).map((li) => li.dataset['messageId'])).toEqual(['m1']);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items()[1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard('r');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '답글 작성' }));
    await user.keyboard('{Escape}');
    expect(document.activeElement?.textContent).toBe('답글');
  });
});
