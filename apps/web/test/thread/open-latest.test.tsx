/** 스레드를 열면 최근 답글(맨 아래)이 보인다 — CMP-06 하단 고정과 같은 규칙(UI_STATES §2-7). */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel, type ThreadVariant } from '../../src/features/thread/index.js';
import type { MessageItemData } from '../../src/features/conversation/index.js';
import { T0 } from '../helpers/fixtures.js';

/** jsdom은 레이아웃이 없다 — 패널 안 메시지 항목 1개 = 100px, 보이는 높이 300px, scrollTop은 [0, max]로 고정. */
const ITEM = 100;
const VIEW = 300;
const tops = new WeakMap<Element, number>();
const descriptors = ['scrollHeight', 'clientHeight', 'scrollTop'].map(
  (k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const,
);
const isPanel = (el: Element) => el.classList.contains('thread-panel');
const height = (el: Element) => (isPanel(el) ? el.querySelectorAll('.msg-item').length * ITEM : 0);

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return height(this); } });
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPanel(this) ? VIEW : 0; } });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0; },
    set(this: Element, v: number) { tops.set(this, Math.max(0, Math.min(v, height(this) - VIEW))); },
  });
});
afterEach(() => {
  cleanup();
  for (const [k, d] of descriptors) {
    if (d === undefined) delete (Element.prototype as unknown as Record<string, unknown>)[k];
    else Object.defineProperty(Element.prototype, k, d);
  }
});

const msg = (id: string, seq: number): MessageItemData & { seq: number } => ({ id, seq, author: '홍길동', createdAt: T0, body: `본문 ${id}` });
const replies = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, i + 2));

function panel(variant: ThreadVariant, root: MessageItemData, rs: readonly MessageItemData[], onSeen?: (seq: number) => void) {
  return (
    <ThreadPanel
      variant={variant}
      root={root}
      replies={rs}
      onClose={() => {}}
      onSend={() => {}}
      announce={() => {}}
      {...(onSeen === undefined ? {} : { onSeen })}
    />
  );
}
const scroller = () => {
  const el = document.querySelector<HTMLElement>('.thread-panel');
  if (el === null) throw new Error('스레드 패널 없음');
  return el;
};
const max = () => height(scroller()) - VIEW;

describe('스레드 열기 → 최근 답글(맨 아래)', () => {
  it.each<ThreadVariant>(['wide', 'medium', 'compact'])('%s: 열면 맨 아래', (variant) => {
    render(panel(variant, msg('m1', 1), replies(10)));
    expect(max()).toBe(1100 - VIEW);
    expect(scroller().scrollTop).toBe(max());
  });

  it('다른 스레드로 바꾸면 다시 맨 아래', () => {
    const view = render(panel('wide', msg('m1', 1), replies(10)));
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    expect(scroller().scrollTop).toBe(0);
    view.rerender(panel('wide', msg('m2', 50), replies(12, 'q')));
    expect(scroller().scrollTop).toBe(1300 - VIEW);
  });

  it('맨 아래면 새 답글을 따라가고, 위로 올려 읽는 중이면 위치를 유지한다', () => {
    const root = msg('m1', 1);
    const view = render(panel('wide', root, replies(10)));
    // 대조군: 맨 아래에서 새 답글 → 따라감.
    view.rerender(panel('wide', root, replies(11)));
    expect(scroller().scrollTop).toBe(1200 - VIEW);
    // 위로 올린 뒤 새 답글 → 유지.
    scroller().scrollTop = 100;
    fireEvent.scroll(scroller());
    view.rerender(panel('wide', root, replies(12)));
    expect(scroller().scrollTop).toBe(100);
  });

  it('강조(data-highlighted) 중에는 새 렌더가 맨 아래로 끌어가지 않는다', () => {
    const root = msg('m1', 1);
    const view = render(panel('wide', root, replies(10)));
    scroller().scrollTop = 200;
    scroller().querySelector('.thread-replies .msg-item')?.setAttribute('data-highlighted', 'true');
    view.rerender(panel('wide', root, replies(11)));
    expect(scroller().scrollTop).toBe(200);
    // 대조(교차 검토 P3): 강조를 지우면 같은 높이 재렌더에서 다시 맨 아래로 — 위 유지가 강조 예외 덕임을 확인.
    scroller().querySelector('[data-highlighted]')?.removeAttribute('data-highlighted');
    view.rerender(panel('wide', root, replies(11)));
    expect(scroller().scrollTop).toBe(max());
  });

  it('답글 0건으로 열렸다가 비동기로 도착하면 맨 아래(교차 검토 P3)', () => {
    const root = msg('m1', 1);
    const view = render(panel('wide', root, []));
    expect(scroller().scrollTop).toBe(0);
    view.rerender(panel('wide', root, replies(10)));
    expect(max()).toBe(1100 - VIEW);
    expect(scroller().scrollTop).toBe(max());
  });

  it('읽음: 답글 0건이면 onSeen 미호출, 답글 있으면 맨 아래로 열려 마지막 seq 알림', () => {
    const none = vi.fn();
    render(panel('wide', msg('m1', 1), [], none));
    expect(none).not.toHaveBeenCalled();
    cleanup();
    const seen = vi.fn();
    render(panel('wide', msg('m2', 1), replies(10), seen));
    expect(seen).toHaveBeenCalledWith(11);
  });
});
