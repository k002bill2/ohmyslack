/** W-11b 시안 반영(01·05·11): 구분선(CMP-09·10)·멘션 강조·툴바·전송 아이콘 버튼. 동작 단언 위주. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Composer, DateSeparator, MessageItem, NewMessagesDivider, dateSeparatorText } from '../../src/features/conversation/index.js';
import { ThreadPanel } from '../../src/features/thread/index.js';

afterEach(cleanup);

const msg = { id: 'm1', author: '김민지', createdAt: '2026-11-08T02:40:00Z', body: '@강영환 확인', authorId: 'u2' };

describe('CMP-10 DateSeparator(UI_STATES §2-4)', () => {
  const now = new Date('2026-11-08T12:00:00');
  it('오늘·어제·YYYY-MM-DD', () => {
    expect(dateSeparatorText(new Date('2026-11-08T01:00:00'), now)).toBe('오늘');
    expect(dateSeparatorText(new Date('2026-11-07T23:00:00'), now)).toBe('어제');
    expect(dateSeparatorText(new Date('2026-10-30T10:00:00'), now)).toBe('2026-10-30');
  });
  it('구분선 역할 + 보조(R4: 오늘·어제는 「11월 8일 일요일」)', () => {
    render(
      <ul>
        <DateSeparator at="2026-11-08T01:00:00" now={now} />
      </ul>,
    );
    const sep = screen.getByRole('separator');
    expect(sep.querySelector('.date-separator-day')?.textContent).toBe('오늘');
    expect(sep.querySelector('.date-separator-weekday')?.textContent).toBe('11월 8일 일요일');
  });
  it('YYYY-MM-DD 라벨에는 요일만 보조로 붙는다', () => {
    render(
      <ul>
        <DateSeparator at="2026-10-30T10:00:00" now={now} />
      </ul>,
    );
    const sep = screen.getByRole('separator');
    expect(sep.querySelector('.date-separator-day')?.textContent).toBe('2026-10-30');
    expect(sep.querySelector('.date-separator-weekday')?.textContent).toBe('금요일');
  });
});

describe('CMP-09 NewMessagesDivider', () => {
  it('「여기부터 새 메시지」 구분선', () => {
    render(
      <ul>
        <NewMessagesDivider />
      </ul>,
    );
    expect(screen.getByRole('separator', { name: '여기부터 새 메시지' }).textContent).toBe('여기부터 새 메시지');
  });
});

describe('MessageItem 시안 01·11', () => {
  it('나를 멘션하면 강조 클래스와 「나를 멘션」 라벨, 아니면 없음', () => {
    const { container, rerender } = render(
      <ul>
        <MessageItem message={msg} mentionsSelf />
      </ul>,
    );
    expect(container.querySelector('.msg-item')?.classList.contains('msg-mentioned')).toBe(true);
    expect(screen.getByText('나를 멘션')).toBeTruthy();
    rerender(
      <ul>
        <MessageItem message={msg} />
      </ul>,
    );
    expect(container.querySelector('.msg-mentioned')).toBeNull();
    expect(screen.queryByText('나를 멘션')).toBeNull();
  });

  it('답글·수정·삭제는 한 툴바 안에 있고 답글이 먼저다', () => {
    const { container } = render(
      <ul>
        <MessageItem message={msg} selfId="u2" onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />
      </ul>,
    );
    const toolbar = container.querySelector('.msg-toolbar');
    const names = Array.from(toolbar?.querySelectorAll('button') ?? []).map((b) => b.textContent);
    expect(names).toEqual(['답글', '수정', '삭제']);
  });
});

describe('Composer 전송 아이콘 버튼(시안 01·05)', () => {
  it('아이콘(svg, 숨김) + 접근 이름 「전송」', () => {
    render(<Composer label="작성기" onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: '전송' });
    expect(send.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ThreadPanel 헤더(시안 01·06)', () => {
  it('「스레드」 제목 + 「채널 · 답글 n」 보조', () => {
    render(
      <ThreadPanel
        variant="wide"
        root={msg}
        replies={[{ ...msg, id: 'r1' }]}
        onClose={vi.fn()}
        onSend={vi.fn()}
        announce={vi.fn()}
        spaceTitle="ohmyslack-개발"
      />,
    );
    expect(screen.getByRole('heading', { name: '스레드' })).toBeTruthy();
    expect(screen.getByText('ohmyslack-개발 · 답글 1')).toBeTruthy();
  });
});
