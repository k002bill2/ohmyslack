import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as renderModule from '../../src/features/conversation/render.js';
import { MessageBody } from '../../src/features/conversation/MessageBody.js';
import { MessageItem, type MessageItemData } from '../../src/features/conversation/MessageItem.js';

vi.mock('../../src/features/conversation/render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/conversation/render.js')>();
  return { ...actual, parseBody: vi.fn(actual.parseBody) };
});

const parseSpy = vi.mocked(renderModule.parseBody);

beforeEach(() => parseSpy.mockClear());
afterEach(cleanup);

const MESSAGE: MessageItemData = { id: 'm1', author: '홍길동', createdAt: '2026-11-07T06:12:00.000Z', body: '안녕 https://example.com' };

describe('F-1 본문 재파싱 방지(useMemo·React.memo)', () => {
  it('MessageBody는 body가 같으면 재렌더해도 다시 파싱하지 않는다', () => {
    const view = render(<MessageBody body="본문 https://example.com" />);
    view.rerender(<MessageBody body="본문 https://example.com" />);
    view.rerender(<MessageBody body="본문 https://example.com" />);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    view.rerender(<MessageBody body="바뀐 본문" />);
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it('MessageItem은 같은 props로 재렌더되면 본문을 다시 파싱하지 않는다', () => {
    const view = render(<MessageItem message={MESSAGE} />);
    view.rerender(<MessageItem message={MESSAGE} />);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('MessageItem에 본문이 같은 새 message 객체가 와도 재파싱하지 않는다', () => {
    const onReply = vi.fn();
    const view = render(<MessageItem message={MESSAGE} onReply={onReply} />);
    view.rerender(<MessageItem message={{ ...MESSAGE }} onReply={onReply} />);
    view.rerender(<MessageItem message={{ ...MESSAGE, author: '김철수' }} onReply={onReply} />);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.msg-author')?.textContent).toBe('김철수');
  });

  it('MessageItem이 memo로 감싸져 있다', () => {
    expect((MessageItem as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
