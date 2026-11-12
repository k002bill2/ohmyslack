/**
 * 터치 기기(hover: none, pointer: coarse)에서 자동 포커스가 입력란에 가지 않는다 — iOS Safari는 프로그래밍 focus로 가상 키보드를 띄운다.
 * 스레드 열기 → 제목(tabIndex=-1), 실패 답글 삭제 → 제목, 본문 실패 항목 삭제 → 메시지 목록. 데스크톱은 기존대로 작성기.
 * 참고 출처: 일반 관념(WCAG 2.4.3).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_DISCARD_FOCUS, withDiscardFocus } from '../../src/features/conversation';
import { AppShell } from '../../src/features/layout';
import { writeCheckpoint } from '../../src/features/sync';
import { ThreadPanel } from '../../src/features/thread';
import { COMPOSER_COPY } from '../../src/ui/copy.js';
import { T0 } from '../helpers/fixtures.js';
import { installViewport, setCoarsePointer } from '../helpers/viewport.js';
import { CONV, ME, U, flush, message, setup, summary } from '../sync/fake-server.js';

afterEach(cleanup);

const ROOT = U(101);
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(flush);
};

function expectNotKeyboardTarget(): void {
  const active = document.activeElement;
  expect(active).not.toBe(document.body);
  expect(active?.tagName).not.toBe('TEXTAREA');
  expect(active?.tagName).not.toBe('INPUT');
}

function renderPanel(onClose: () => void = () => undefined) {
  const root = { id: 'm1', author: '홍길동', createdAt: T0, body: '원문' };
  render(<ThreadPanel variant="medium" root={root} replies={[]} onClose={onClose} onSend={() => undefined} announce={() => undefined} />);
  return screen.getByRole('dialog', { name: '스레드' });
}

describe('스레드 열기 자동 포커스', () => {
  it('터치: 제목(tabIndex=-1)으로 — 입력란·body 아님', () => {
    installViewport(900);
    setCoarsePointer(true);
    const panel = renderPanel();
    expectNotKeyboardTarget();
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { name: '스레드' }));
  });

  it('데스크톱: 기존대로 답글 작성기', () => {
    installViewport(900);
    const panel = renderPanel();
    expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }));
  });

  it('터치 medium: 제목에서 Tab → 첫 대상, Shift+Tab → 마지막 대상(제목은 트랩 정거장 아님), Esc → 닫기', () => {
    installViewport(900);
    setCoarsePointer(true);
    let closed = 0;
    const panel = renderPanel(() => (closed += 1));
    const heading = within(panel).getByRole('heading', { name: '스레드' });
    const stops = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), textarea:not(:disabled), [tabindex]')).filter((el) => el.tabIndex >= 0);
    expect(stops).not.toContain(heading);
    fireEvent.keyDown(heading, { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);
    heading.focus();
    fireEvent.keyDown(heading, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stops.at(-1));
    heading.focus();
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(closed).toBe(1);
  });
});

async function mountShell() {
  installViewport(1400);
  setCoarsePointer(true);
  let id = 0;
  const ctx = setup({ newClientMessageId: () => U(900 + (id += 1)) });
  ctx.server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: [summary()], next_cursor: null } }));
  ctx.server.on(`GET /api/conversations/${CONV}/messages`, () => ({ status: 200, body: { messages: [message(1)], has_more: false } }));
  ctx.server.on(`GET /api/messages/${ROOT}/replies`, () => ({ status: 200, body: { root: message(1), replies: [], has_more: false } }));
  ctx.server.on('GET /api/users/names', () => ({ status: 200, body: { users: [] } }));
  ctx.server.on(`POST /api/conversations/${CONV}/messages`, () => ({ status: 500 }));
  writeCheckpoint(ME, 3, ctx.storage);
  render(<AppShell dataSource={ctx.ds} />);
  await act(async () => {
    await ctx.ds.resume();
  });
  await settle();
  return userEvent.setup();
}

describe('터치: 실패 항목 지운 뒤 포커스', () => {
  it('본문 실패 항목 「삭제」 → 메시지 목록(작성기·body 아님, AppShell tabIndex=-1)', async () => {
    const user = await mountShell();
    await user.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    await user.type(screen.getByRole('textbox', { name: '#general에 메시지 작성' }), '본문 실패{Enter}');
    await settle();
    const list = document.querySelector<HTMLElement>('.message-list');
    if (list === null) throw new Error('목록 없음');
    within(list).getByRole('button', { name: '삭제' }).focus();
    await user.keyboard('{Enter}');
    await settle();
    expect(screen.queryByText('본문 실패')).toBeNull();
    expectNotKeyboardTarget();
    expect(document.activeElement).toBe(list);
  });

  it('스레드 열기 → 제목, 실패 답글 「삭제」 → 제목(작성기·body 아님)', async () => {
    const user = await mountShell();
    await user.click(within(screen.getByRole('navigation', { name: '공간' })).getByRole('button', { name: 'general' }));
    await settle();
    const trigger = document.querySelector<HTMLElement>(`[data-reply-for="${ROOT}"]`);
    if (trigger === null) throw new Error('답글 버튼 없음');
    await user.click(trigger);
    await settle();
    const panel = screen.getByRole('complementary', { name: '스레드' });
    const heading = within(panel).getByRole('heading', { name: '스레드' });
    expect(document.activeElement).toBe(heading);
    await user.type(within(panel).getByRole('textbox', { name: COMPOSER_COPY.replyLabel }), '답글{Enter}');
    await settle();
    within(panel).getByRole('button', { name: '삭제' }).focus();
    await user.keyboard('{Enter}');
    await settle();
    expect(within(panel).queryByText('답글')).toBeNull();
    expectNotKeyboardTarget();
    expect(document.activeElement).toBe(heading);
  });
});

/** 본문 구조 축약: 작성기 + 메시지 목록(tabIndex=-1은 AppShell이 붙인다). */
function MainFixture({ onDiscard }: { readonly onDiscard: (id: string) => void }) {
  const pane = useRef<HTMLElement>(null);
  const discard = withDiscardFocus(pane, onDiscard, MAIN_DISCARD_FOCUS);
  return (
    <main ref={pane}>
      <ul className="message-list" tabIndex={-1}>
        <li>
          <button type="button" onClick={() => discard('c1')}>
            삭제
          </button>
        </li>
      </ul>
      <div data-composer="main">
        <textarea className="composer-input" aria-label="작성" />
      </div>
    </main>
  );
}

describe('withDiscardFocus 본문', () => {
  it('터치: 작성기를 건너뛰고 메시지 목록으로', () => {
    installViewport(390);
    setCoarsePointer(true);
    const ids: string[] = [];
    render(<MainFixture onDiscard={(id) => ids.push(id)} />);
    const button = screen.getByRole('button', { name: '삭제' });
    button.focus();
    fireEvent.click(button);
    expect(ids).toEqual(['c1']);
    expectNotKeyboardTarget();
    expect(document.activeElement).toBe(document.querySelector('.message-list'));
  });

  it('데스크톱: 기존대로 작성기', () => {
    installViewport(1400);
    render(<MainFixture onDiscard={() => undefined} />);
    const button = screen.getByRole('button', { name: '삭제' });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '작성' }));
  });
});
