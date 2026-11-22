/**
 * 메시지 본문 코드 블록 「복사」 버튼(CMP-08, UI_STATES §2-5 MessageBody).
 * - 코드 블록마다 버튼 1개(인라인 코드·다른 블록 없음), 자기 블록 원문 그대로 1회 복사.
 * - 버튼은 아이콘 단독(Lucide copy/check/x, 보이는 글자 0) — 접근 이름은 3상태 모두 「코드 복사」 고정, 결과 낭독은 role=status.
 * - 성공 check 아이콘 1600ms 후 copy 복귀(연속 성공 시 다시 셈) / 실패(clipboard 없음·거부) x 아이콘·안내 「복사하지 못했습니다」(role=status).
 * - 버튼은 pre 밖(가로 스크롤과 함께 밀리지 않게) — pre textContent에 버튼 내용 없음.
 * - 버튼의 click·키 이벤트가 메시지 항목 동작(답글·수정·삭제·메뉴·액션 시트)을 일으키지 않는다.
 * 기대 문구는 리터럴로 비교한다(상수 import 없음).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBody } from '../../src/features/conversation/MessageBody.js';
import { MessageItem, type MessageItemData } from '../../src/features/conversation';
import type { ActionResult } from '../../src/data/index.js';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let writeText: ReturnType<typeof vi.fn>;

function installClipboard(impl: (text: string) => Promise<void>) {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

beforeEach(() => installClipboard(async () => undefined));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
  else Object.defineProperty(navigator, 'clipboard', original);
});

const LONG = 'cd /Users/x/project && agy --conversation 1234567890abcdef --very-long-flag value';
const MULTI = '  첫 줄 들여쓰기\n\tif (a) {\n    b();\n  }\n';

/** await 체인(writeClipboard → then → setState)을 비운다. */
/** 버튼 안 아이콘 상태(svg data-icon). 보이는 글자가 없음도 함께 확인한다. */
function iconOf(button: HTMLElement): string | null {
  expect(button.textContent).toBe('');
  expect(button.getAttribute('aria-label')).toBe('코드 복사');
  expect(button.getAttribute('title')).toBe('코드 복사');
  const svgs = button.querySelectorAll('svg');
  expect(svgs).toHaveLength(1);
  return svgs[0]?.getAttribute('data-icon') ?? null;
}

/** Lucide 원본(icons/<name>.svg) 도형 — 좌표 오타 방지용 리터럴. */
const LUCIDE: Record<string, { readonly paths: readonly string[]; readonly rect?: Record<string, string> }> = {
  copy: { paths: ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'], rect: { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' } },
  check: { paths: ['M20 6 9 17l-5-5'] },
  x: { paths: ['M18 6 6 18', 'm6 6 12 12'] },
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('코드 블록 복사 버튼', () => {
  it('코드 블록마다 「코드 복사」 버튼 1개, 보이는 글자 없이 copy 아이콘', () => {
    render(<MessageBody body={'```\n' + LONG + '\n```'} />);
    const buttons = screen.getAllByRole('button', { name: '코드 복사' });
    expect(buttons).toHaveLength(1);
    expect(iconOf(buttons[0] as HTMLElement)).toBe('copy');
  });

  it('아이콘 svg는 장식(aria-hidden·focusable=false)이고 Lucide 원본 도형·24 그리드·16px·stroke 2', async () => {
    installClipboard(async () => {
      throw new Error('denied');
    });
    render(<MessageBody body={'```\nx\n```\n```\ny\n```'} />);
    const [a, b] = screen.getAllByRole('button', { name: '코드 복사' }) as HTMLElement[];
    installClipboard(async () => undefined);
    fireEvent.click(a as HTMLElement);
    await flush();
    installClipboard(async () => {
      throw new Error('denied');
    });
    fireEvent.click(b as HTMLElement);
    await flush();
    const svgs = [...document.querySelectorAll('.msg-code-copy svg')];
    expect(svgs.map((s) => s.getAttribute('data-icon'))).toEqual(['check', 'x']);
    render(<MessageBody body={'```\nz\n```'} />);
    const all = [...document.querySelectorAll('.msg-code-copy svg')];
    expect(all.map((s) => s.getAttribute('data-icon'))).toEqual(['check', 'x', 'copy']);
    for (const svg of all) {
      const spec = LUCIDE[svg.getAttribute('data-icon') ?? ''];
      expect(spec).toBeDefined();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('width')).toBe('16');
      expect(svg.getAttribute('height')).toBe('16');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe('2');
      expect(svg.getAttribute('stroke-linecap')).toBe('round');
      expect(svg.getAttribute('stroke-linejoin')).toBe('round');
      expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(spec?.paths);
      const rect = svg.querySelector('rect');
      if (spec?.rect === undefined) expect(rect).toBeNull();
      else for (const [k, v] of Object.entries(spec.rect)) expect(rect?.getAttribute(k)).toBe(v);
      expect(svg.getAttribute('style')).toBeNull();
    }
  });

  it('클릭 → 그 블록 원문으로 writeText 정확히 1회', async () => {
    render(<MessageBody body={'```\n' + LONG + '\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it('여러 줄·앞 공백·탭을 가공 없이 보존한다(pre textContent와 같음)', async () => {
    const { container } = render(<MessageBody body={'```\n' + MULTI + '```'} />);
    const pre = container.querySelector('pre.msg-code') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(pre.textContent);
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^ {2}첫 줄 들여쓰기\n\tif/);
  });

  it('블록이 여러 개면 각 버튼이 자기 블록만 복사한다', async () => {
    render(<MessageBody body={'```\nfirst\n```\n사이 문단\n```\nsecond\n```'} />);
    const [a, b] = screen.getAllByRole('button', { name: '코드 복사' });
    fireEvent.click(b as HTMLElement);
    await flush();
    fireEvent.click(a as HTMLElement);
    await flush();
    expect(writeText.mock.calls).toEqual([['second'], ['first']]);
  });

  it('pre.msg-code textContent에 버튼 글자가 섞이지 않는다(버튼은 pre 밖)', () => {
    const { container } = render(<MessageBody body={'```\n' + LONG + '\n```'} />);
    const pre = container.querySelector('pre.msg-code') as HTMLElement;
    expect(pre.textContent).toBe(LONG);
    expect(pre.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: '코드 복사' }).closest('.msg-code-block')).toBe(pre.parentElement);
  });

  it('성공 → check 아이콘·「복사됨」 낭독, 1600ms 뒤 copy 아이콘으로 복귀(접근 이름은 계속 「코드 복사」)', async () => {
    vi.useFakeTimers();
    render(<MessageBody body={'```\nx\n```'} />);
    const button = screen.getByRole('button', { name: '코드 복사' });
    fireEvent.click(button);
    await flush();
    expect(iconOf(button)).toBe('check');
    expect(screen.getByRole('status').textContent).toBe('복사됨');
    act(() => vi.advanceTimersByTime(1599));
    expect(iconOf(button)).toBe('check');
    act(() => vi.advanceTimersByTime(1));
    expect(iconOf(button)).toBe('copy');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('상태 영역(role=status)은 처음부터 빈 채로 렌더되고 글자만 바뀐다', async () => {
    render(<MessageBody body={'```\nx\n```'} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }));
    await flush();
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('복사됨');
  });

  it('연속 성공이면 1600ms를 다시 센다(1000ms 뒤 재클릭 → 그 뒤 1000ms에도 check, 600ms 더 지나면 copy)', async () => {
    vi.useFakeTimers();
    render(<MessageBody body={'```\nx\n```'} />);
    const button = screen.getByRole('button', { name: '코드 복사' });
    fireEvent.click(button);
    await flush();
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(button);
    await flush();
    act(() => vi.advanceTimersByTime(1000));
    expect(iconOf(button)).toBe('check');
    act(() => vi.advanceTimersByTime(600));
    expect(iconOf(button)).toBe('copy');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('거부(reject) → x 아이콘·「복사하지 못했습니다」 낭독, 포커스는 버튼에 그대로', async () => {
    installClipboard(async () => {
      throw new Error('denied');
    });
    render(<MessageBody body={'```\nx\n```'} />);
    const button = screen.getByRole('button', { name: '코드 복사' });
    button.focus();
    fireEvent.click(button);
    await flush();
    expect(screen.getByRole('status').textContent).toBe('복사하지 못했습니다');
    expect(iconOf(button)).toBe('x');
    expect(document.activeElement).toBe(button);
  });

  it('clipboard 없음 → 「복사하지 못했습니다」', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<MessageBody body={'```\nx\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }));
    await flush();
    expect(screen.getByRole('status').textContent).toBe('복사하지 못했습니다');
  });

  it('언마운트 시 타이머를 정리한다(경고·setState 없음)', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<MessageBody body={'```\nx\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }));
    await flush();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('인라인 코드·일반 문단·목록·제목에는 버튼이 없다', () => {
    render(<MessageBody body={'# 제목\n문단 `inline` 코드\n- 항목 `x`'} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('버튼 이벤트가 메시지 항목 동작을 일으키지 않는다', () => {
  const ME = 'me';
  const msg: MessageItemData = { id: 'm1', author: 'A', createdAt: '2026-11-07T00:00:00Z', body: '```\nls -la\n```', authorId: ME, replyCount: 0 };
  const ok: ActionResult<null> = { ok: true, value: null };

  function renderItem(actionMode: 'toolbar' | 'sheet') {
    const onReply = vi.fn();
    const onEdit = vi.fn(async (): Promise<ActionResult<null>> => ok);
    const onDelete = vi.fn(async (): Promise<ActionResult<null>> => ok);
    render(
      <ul>
        <MessageItem message={msg} selfId={ME} onReply={onReply} onEdit={onEdit} onDelete={onDelete} actionMode={actionMode} />
      </ul>,
    );
    const li = screen.getByRole('listitem');
    const button = within(li).getByRole('button', { name: '코드 복사' });
    return { li, button, onReply, onEdit, onDelete };
  }

  it('toolbar 대조군: 같은 키를 항목(li)에 보내면 답글·수정·삭제·메뉴가 실제로 열린다', () => {
    const reply = renderItem('toolbar');
    fireEvent.keyDown(reply.li, { key: 'r', code: 'KeyR' });
    expect(reply.onReply).toHaveBeenCalledWith('m1');
    cleanup();
    const edit = renderItem('toolbar');
    fireEvent.keyDown(edit.li, { key: 'e', code: 'KeyE' });
    expect(edit.li.querySelector('textarea')).not.toBeNull();
    cleanup();
    const del = renderItem('toolbar');
    fireEvent.keyDown(del.li, { key: 'Delete', code: 'Delete' });
    expect(screen.getByRole('dialog', { name: '메시지 삭제' })).not.toBeNull();
    cleanup();
    const menu = renderItem('toolbar');
    fireEvent.keyDown(menu.li, { key: 'F10', code: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).not.toBeNull();
  });

  it('toolbar: 클릭·Enter·Space·R·E·Delete·Shift+F10 → 답글·수정·삭제·메뉴 없음, 복사만', async () => {
    const { li, button, onReply } = renderItem('toolbar');
    button.focus();
    fireEvent.click(button);
    await flush();
    for (const init of [
      { key: 'Enter', code: 'Enter' },
      { key: ' ', code: 'Space' },
      { key: 'r', code: 'KeyR' },
      { key: 'e', code: 'KeyE' },
      { key: 'Delete', code: 'Delete' },
      { key: 'Backspace', code: 'Backspace' },
      { key: 'F10', code: 'F10', shiftKey: true },
    ]) {
      fireEvent.keyDown(button, init);
    }
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
    expect(li.querySelector('textarea')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('sheet(compact): 버튼 길게 누르기·클릭이 액션 시트를 열지 않는다', async () => {
    vi.useFakeTimers();
    const { li, button } = renderItem('sheet');
    fireEvent.pointerDown(button, { button: 0, isPrimary: true, clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(1);
    // 대조군: 같은 누르기를 본문(.msg-body)에 하면 시트가 열린다 — 위 부정 단언이 거저 통과하지 않음을 보인다.
    fireEvent.pointerDown(li.querySelector('.msg-body') as HTMLElement, { button: 0, isPrimary: true, clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('dialog')).not.toBeNull();
  });
});
