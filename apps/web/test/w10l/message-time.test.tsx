import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { MessageItem } from '../../src/features/conversation';
import { T0, memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

/** MessageItem의 기존 TIME 포맷과 같은 옵션(새 포맷 신설 금지 — 값 비교용). */
const TIME = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

async function open(width: number) {
  installViewport(width);
  const user = userEvent.setup();
  render(<App dataSource={memory()} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  const item = document.querySelector<HTMLElement>('[data-message-id="m1"]');
  if (item === null) throw new Error('m1 없음');
  return item;
}

describe('메시지 시각 표시(UI_STATES §3 타임스탬프 행)', () => {
  it.each([
    [1280, 'inline'],
    [800, 'inline'],
    [400, 'below'],
  ])('폭 %ipx → <time dateTime> 보이는 텍스트 = TIME 포맷, 위치 %s', async (width, placement) => {
    const item = await open(width);
    const time = item.querySelector('time');
    expect(time).not.toBeNull();
    expect(time?.getAttribute('dateTime')).toBe(T0);
    expect(time?.textContent).toBe(TIME.format(new Date(T0)));
    expect(time?.classList.contains(`msg-time-${placement}`)).toBe(true);
    // 접근 이름은 기존 항목 aria-label 그대로, 보이는 시각은 중복 낭독 방지로 aria-hidden.
    expect(time?.getAttribute('aria-hidden')).toBe('true');
    expect(item.getAttribute('aria-label')).toBe(`홍길동, ${TIME.format(new Date(T0))}`);
    const author = item.querySelector('.msg-author');
    const body = item.querySelector('.msg-body');
    if (placement === 'inline') expect(author?.nextElementSibling).toBe(time);
    else expect(body?.compareDocumentPosition(time as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('수정된 메시지는 시각 title에 수정 시각(TIME 포맷)', () => {
    const edited = '2026-11-07T07:30:00.000Z';
    render(
      <ul>
        <MessageItem message={{ id: 'e1', author: '나', createdAt: T0, body: '본문', authorId: 'u1', editedAt: edited }} />
      </ul>,
    );
    const time = document.querySelector('time');
    expect(time?.getAttribute('title')).toBe(TIME.format(new Date(edited)));
  });

  it('삭제 자리표시자에는 「답글」이 없고, 답글 수가 있으면 CMP-14만 남는다(UI_STATES §2-5 「스레드 열기만」)', () => {
    render(
      <ul>
        <MessageItem
          message={{ id: 'd1', author: '나', createdAt: T0, body: '', authorId: 'u1', deleted: true, replyCount: 2 }}
          onReply={() => undefined}
          onOpenThread={() => undefined}
        />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: '답글' })).toBeNull();
    expect(document.querySelector('[data-thread-summary-for="d1"]')).not.toBeNull();
  });
});
