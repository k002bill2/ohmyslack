import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { breakpoints } from '../../src/ui/tokens.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport, resizeTo } from '../helpers/viewport.js';

afterEach(cleanup);

/** 구간 상수에서 경계 전후 폭을 만든다(정본 수치를 테스트에 복제하지 않음). */
const { compactMax: C, wideMin: W, threadRoomyMin: R } = breakpoints;
const COMPACT = [320, 390, C - 1, C];
const MEDIUM = [C + 0.5, C + 1, W - 1, W - 0.5];
const WIDE_NARROW = [W, W + 1, R - 1];
const WIDE_ROOMY = [R, 1280, 1440];

function shell(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.app-shell');
  if (el === null) throw new Error('app-shell 없음');
  return el;
}

function regions() {
  return {
    nav: screen.queryByRole('navigation', { name: '공간' }),
    main: screen.queryByRole('main'),
    aside: screen.queryByRole('complementary', { name: '스레드' }),
    dialog: screen.queryByRole('dialog', { name: '스레드' }),
    page: screen.queryByRole('region', { name: '스레드' }),
  };
}

async function openGeneralThread(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'general' }));
  const [reply] = screen.getAllByRole('button', { name: '답글' });
  if (reply === undefined) throw new Error('답글 버튼 없음');
  await user.click(reply);
}

describe('FR-CLIENT-02 반응형', () => {
  it('FR-CLIENT-02 디자인 정본의 모든 구간과 경계 전후 폭에서 정본 단수로 렌더되고 compact에서 공간 본문 스레드 뒤로 이동이 된다', async () => {
    for (const width of COMPACT) {
      installViewport(width);
      const user = userEvent.setup();
      const { container, unmount } = render(<App dataSource={memory()} />);
      expect(shell(container).dataset.layout).toBe('compact');
      // 1단: 공간 목록 → 본문 → 스레드 → 뒤로 → 뒤로.
      expect(regions()).toMatchObject({ main: null, aside: null, dialog: null, page: null });
      expect(regions().nav).not.toBeNull();
      await user.click(screen.getByRole('button', { name: 'general' }));
      expect(regions()).toMatchObject({ nav: null, page: null });
      expect(regions().main).not.toBeNull();
      await user.click(screen.getAllByRole('button', { name: '답글' })[0] as HTMLElement);
      expect(regions()).toMatchObject({ nav: null, main: null, aside: null, dialog: null });
      expect(regions().page).not.toBeNull();
      await user.click(screen.getByRole('button', { name: '뒤로' }));
      expect(regions().page).toBeNull();
      expect(regions().main).not.toBeNull();
      expect(document.activeElement).toBe(screen.getAllByRole('button', { name: '답글' })[0]);
      await user.click(screen.getByRole('button', { name: '뒤로' }));
      expect(regions().main).toBeNull();
      expect(regions().nav).not.toBeNull();
      unmount();
    }

    for (const width of MEDIUM) {
      installViewport(width);
      const user = userEvent.setup();
      const { container, unmount } = render(<App dataSource={memory()} />);
      expect(shell(container).dataset.layout).toBe('medium');
      await openGeneralThread(user);
      // 2단: 사이드바 + 본문, 스레드는 오버레이 dialog, 본문 inert.
      const r = regions();
      expect(r.nav).not.toBeNull();
      expect(r.main?.hasAttribute('inert')).toBe(true);
      expect(r.dialog?.getAttribute('aria-modal')).toBe('true');
      expect(r.aside).toBeNull();
      expect(shell(container).dataset.sidebar).toBe('expanded');
      unmount();
    }

    for (const [widths, collapsedWhenOpen] of [[WIDE_NARROW, true], [WIDE_ROOMY, false]] as const) {
      for (const width of widths) {
        installViewport(width);
        const user = userEvent.setup();
        const { container, unmount } = render(<App dataSource={memory()} />);
        const el = shell(container);
        expect(el.dataset.layout).toBe('wide');
        await openGeneralThread(user);
        // 3단: 사이드바 + 본문 + 스레드 aside. 1120 미만이면 사이드바 72px 접힘(§5-2 필수).
        const r = regions();
        expect(r.nav).not.toBeNull();
        expect(r.main?.hasAttribute('inert')).toBe(false);
        expect(r.aside).not.toBeNull();
        expect(r.dialog).toBeNull();
        expect(el.dataset.sidebar).toBe(collapsedWhenOpen ? 'collapsed' : 'expanded');
        await user.click(within(r.aside as HTMLElement).getByRole('button', { name: '닫기' }));
        expect(el.dataset.sidebar).toBe('expanded');
        unmount();
      }
    }

    // T5: 스레드가 열린 채 폭이 구간을 넘으면 같은 상태를 새 구간 표현으로 다시 그린다.
    installViewport(1280);
    const user = userEvent.setup();
    const { container } = render(<App dataSource={memory()} />);
    await openGeneralThread(user);
    const el = shell(container);
    expect(el.dataset.sidebar).toBe('expanded');
    act(() => resizeTo(R - 1));
    expect(el.dataset.sidebar).toBe('collapsed');
    act(() => resizeTo(W - 0.5));
    expect(el.dataset.layout).toBe('medium');
    expect(regions().dialog).not.toBeNull();
    act(() => resizeTo(C));
    expect(el.dataset.layout).toBe('compact');
    expect(regions().page).not.toBeNull();
  });
});
