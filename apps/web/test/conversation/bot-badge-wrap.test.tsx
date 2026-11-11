/**
 * 봇 배지 회귀 QA D-1: 1440 스레드 패널에서 긴 봇 이름 + 「(비활성)」일 때 「봇」 배지만 다음 줄로 넘어갔다.
 * 비활성 봇은 접미 「(비활성)」과 배지를 nowrap 한 덩어리(.name-tail)로 묶는다(DOM 구조로 — 문자열 파싱 없음).
 * 활성 봇·사람 작성자 구조와 접근 이름은 그대로. jsdom은 레이아웃이 없어 CSS는 규칙으로 본다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageItem, type MessageItemData } from '../../src/features/conversation';
import { AUTHOR_NAME_COPY } from '../../src/ui/copy.js';
import { ME, U } from '../sync/fake-server.js';

afterEach(cleanup);

const LONG = 'QA 알림 봇 아주 긴 이름 테스트용 봇';
const at = '2026-11-08T00:00:00Z';
const msg = (extra: Partial<MessageItemData>): MessageItemData => ({ id: 'm1', author: LONG, createdAt: at, body: '본문', authorId: U(9), replyCount: 0, ...extra });
const renderItem = (message: MessageItemData) =>
  render(
    <ul>
      <MessageItem message={message} selfId={ME} onEdit={vi.fn()} onDelete={vi.fn()} onReply={vi.fn()} />
    </ul>,
  );
const inactiveBot = () => msg({ author: AUTHOR_NAME_COPY.inactive(LONG), authorInactiveName: LONG, authorKind: 'bot' });

describe('QA D-1 — 비활성 봇 작성자: 접미와 배지가 한 nowrap 묶음', () => {
  it('접미 「(비활성)」과 「봇」 배지가 같은 .name-tail 안, 이름 본문은 밖(줄바꿈 허용)', () => {
    renderItem(inactiveBot());
    const author = screen.getByRole('listitem').querySelector('.msg-author');
    const tail = author?.querySelector(':scope > .name-tail');
    expect(tail).not.toBeNull();
    expect(tail?.querySelector(':scope > .name-suffix')?.textContent).toBe(AUTHOR_NAME_COPY.inactiveSuffix);
    expect(tail?.querySelector(':scope > .bot-badge')?.textContent).toBe('봇');
    expect(author?.querySelector(':scope > .name-base')?.textContent).toBe(LONG);
    expect(tail?.querySelector('.name-base')).toBeNull();
  });

  it('작성자 글자·메시지 접근 이름은 그대로', () => {
    renderItem(inactiveBot());
    const item = screen.getByRole('listitem');
    expect(item.querySelector('.msg-author')?.textContent).toBe(`${AUTHOR_NAME_COPY.inactive(LONG)}봇`);
    expect(item.getAttribute('aria-label')).toMatch(new RegExp(`^${AUTHOR_NAME_COPY.inactive(LONG).replace(/[()]/g, '\\$&')} 봇, `));
  });

  it('활성 봇은 기존 구조(배지가 .msg-author 바로 아래), 묶음 없음', () => {
    renderItem(msg({ authorKind: 'bot' }));
    const author = screen.getByRole('listitem').querySelector('.msg-author');
    expect(author?.querySelector(':scope > .bot-badge')).not.toBeNull();
    expect(author?.querySelector('.name-tail')).toBeNull();
    expect(author?.innerHTML).toBe(`${LONG}<span class="bot-badge">봇</span>`);
  });

  it('비활성 사람 작성자는 기존 구조(배지·묶음 없음)', () => {
    renderItem(msg({ author: AUTHOR_NAME_COPY.inactive('김철수'), authorInactiveName: '김철수', authorKind: 'human' }));
    const author = screen.getByRole('listitem').querySelector('.msg-author');
    expect(author?.querySelector('.name-tail')).toBeNull();
    expect(author?.querySelector(':scope > .name-suffix')).not.toBeNull();
  });

  it('CSS: .name-tail은 white-space nowrap', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    expect(/\.name-tail \{([^}]*)\}/.exec(css)?.[1]).toMatch(/white-space: nowrap/);
  });
});
