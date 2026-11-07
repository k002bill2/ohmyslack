import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.js';
import { isAtBottom, PIN_THRESHOLD_PX } from '../../src/features/layout/pin-bottom.js';
import { T0, memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

/** jsdom은 레이아웃이 없다 — 목록 항목 1개 = 100px, 보이는 높이 300px로 스텁하고 scrollTop은 [0, max]로 고정한다. */
const ITEM = 100;
let VIEW = 300;
const tops = new WeakMap<Element, number>();
const descriptors = ['scrollHeight', 'clientHeight', 'scrollTop'].map(
  (k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const,
);
const height = (el: Element) => (el.classList.contains('message-list') ? el.children.length * ITEM : 0);

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return height(this); } });
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return VIEW; } });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0; },
    set(this: Element, v: number) { tops.set(this, Math.max(0, Math.min(v, height(this) - VIEW))); },
  });
});
afterEach(() => {
  cleanup();
  VIEW = 300;
  vi.unstubAllGlobals();
  for (const [k, d] of descriptors) {
    if (d === undefined) delete (Element.prototype as unknown as Record<string, unknown>)[k];
    else Object.defineProperty(Element.prototype, k, d);
  }
});

const many = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`, conversationId: 'c1', author: '홍길동', createdAt: T0, body: `메시지 ${i}`, replyCount: 0,
}));

async function openGeneral() {
  installViewport(1280);
  const ds = memory({ messages: many });
  const user = userEvent.setup();
  render(<App dataSource={ds} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  const list = document.querySelector<HTMLElement>('.message-list');
  if (list === null) throw new Error('목록 없음');
  return { ds, list };
}

describe('CMP-06 하단 고정(UI_STATES §2-4)', () => {
  it('isAtBottom: 임계 이내는 맨 아래, 넘으면 아님', () => {
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - PIN_THRESHOLD_PX })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - PIN_THRESHOLD_PX - 1 })).toBe(false);
  });

  it('첫 진입은 맨 아래, 맨 아래에서 새 메시지가 오면 따라 내려간다', async () => {
    const { ds, list } = await openGeneral();
    expect(list.scrollTop).toBe(1000 - VIEW);
    act(() => ds.send({ conversationId: 'c1' }, '새 메시지'));
    expect(list.children).toHaveLength(11);
    expect(list.scrollTop).toBe(1100 - VIEW);
  });

  it('위로 올려 읽는 중이면 새 메시지·자기 전송이 와도 위치를 유지한다', async () => {
    const { ds, list } = await openGeneral();
    list.scrollTop = 100;
    fireEvent.scroll(list);
    act(() => ds.send({ conversationId: 'c1' }, '새 메시지'));
    expect(list.children).toHaveLength(11);
    expect(list.scrollTop).toBe(100);
    // 다시 맨 아래로 내리면 고정이 되살아난다.
    list.scrollTop = 10_000;
    fireEvent.scroll(list);
    act(() => ds.send({ conversationId: 'c1' }, '또 새 메시지'));
    expect(list.scrollTop).toBe(1200 - VIEW);
  });

  it('보이는 높이가 줄면(작성기 여러 줄·배너) 맨 아래일 때만 다시 맨 아래로(Codex r1 P2)', async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) { callbacks.push(cb); }
        observe() {}
        disconnect() {}
      },
    );
    const { list } = await openGeneral();
    expect(callbacks.length).toBeGreaterThan(0);
    VIEW = 200;
    act(() => callbacks.forEach((cb) => cb()));
    expect(list.scrollTop).toBe(1000 - 200);
    // 위로 올려 읽는 중이면 높이가 바뀌어도 그대로.
    list.scrollTop = 100;
    fireEvent.scroll(list);
    VIEW = 150;
    act(() => callbacks.forEach((cb) => cb()));
    expect(list.scrollTop).toBe(100);
  });
});
