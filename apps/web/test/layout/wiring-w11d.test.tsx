/**
 * W-11d 배선: CMP-10 날짜 구분선·CMP-09 「여기부터 새 메시지」(진입 시점 고정, UI_STATES §2-4),
 * 헤더 「채널 · 멤버 n」(시안 01), 스레드 요약 「↳」(장식), compact 설치 안내 카드(시안 04).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/features/layout/AppShell.js';
import { firstUnreadSeq } from '../../src/features/layout/message-dividers.js';
import type { DataSource, Message, Snapshot, Space } from '../../src/data';
import { installViewport } from '../helpers/viewport.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DAY1 = '2026-11-06T03:00:00.000Z';
const DAY2 = '2026-11-07T03:00:00.000Z';

function msg(id: string, seq: number, createdAt: string, extra: Partial<Message> = {}): Message {
  return { id, conversationId: 'c1', author: '홍길동', createdAt, body: `본문 ${id}`, replyCount: 0, seq, ...extra };
}

function source(initial: Snapshot, extra: Partial<DataSource> = {}) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const ds: DataSource = {
    getSnapshot: () => snap,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    send: () => undefined,
    ...extra,
  };
  const set = (next: Snapshot) => {
    snap = next;
    act(() => listeners.forEach((l) => l()));
  };
  return { ds, set, get: () => snap };
}

const space = (over: Partial<Space> = {}): Space => ({ id: 'c1', kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0, ...over });

async function enter(ds: DataSource, width = 1440) {
  installViewport(width);
  const user = userEvent.setup();
  render(<AppShell dataSource={ds} />);
  await user.click(screen.getByRole('button', { name: 'general' }));
  return document.querySelector('.message-list') as HTMLElement;
}

describe('firstUnreadSeq', () => {
  const roots = [msg('a', 1, DAY2), msg('b', 2, DAY2), msg('c', 3, DAY2)];
  it('뒤에서 unread개째 서버 원문의 seq', () => {
    expect(firstUnreadSeq(roots, 2)).toBe(2);
    expect(firstUnreadSeq(roots, 3)).toBe(1);
  });
  it('0이거나 목록보다 많으면 없음(첫 미읽음이 화면 목록 밖)', () => {
    expect(firstUnreadSeq(roots, 0)).toBeNull();
    expect(firstUnreadSeq(roots, 4)).toBeNull();
  });
  it('전송 대기 항목은 세지 않는다', () => {
    const pending = { ...msg('p', 0, DAY2), seq: undefined, pending: { clientMessageId: 'x' } } as unknown as Message;
    expect(firstUnreadSeq([...roots, pending], 1)).toBe(3);
  });
});

describe('MessageList 구분선 배선', () => {
  it('날짜가 바뀌는 원문 앞마다 DateSeparator, 첫 미읽음 앞 1개 NewMessagesDivider', async () => {
    const { ds } = source({
      spaces: [space({ unreadCount: 2 })],
      messages: [msg('a', 1, DAY1), msg('b', 2, DAY2), msg('c', 3, DAY2)],
      connection: 'connected',
    });
    const list = await enter(ds);
    const kinds = [...list.children].map((el) =>
      el.classList.contains('date-separator') ? 'date' : el.classList.contains('new-messages-divider') ? 'new' : el.getAttribute('data-message-id'),
    );
    expect(kinds).toEqual(['date', 'a', 'date', 'new', 'b', 'c']);
    expect(list.querySelectorAll('.new-messages-divider')).toHaveLength(1);
  });

  it('읽음 저장으로 unreadCount가 0이 돼도 진입 시점 위치를 유지하고, 다른 공간 다녀오면 다시 계산', async () => {
    const roots = [msg('a', 1, DAY2), msg('b', 2, DAY2)];
    const other: Space = { ...space(), id: 'c2', name: 'dev' };
    const { ds, set, get } = source({ spaces: [space({ unreadCount: 1 }), other], messages: roots, connection: 'connected' });
    const list = await enter(ds);
    expect(list.querySelector('.new-messages-divider + [data-message-id="b"]')).not.toBeNull();
    set({ ...get(), spaces: [space({ unreadCount: 0 }), other] });
    expect(document.querySelectorAll('.new-messages-divider')).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'dev' }));
    await user.click(screen.getByRole('button', { name: 'general' }));
    expect(document.querySelectorAll('.new-messages-divider')).toHaveLength(0);
  });

  it('이력이 아직 없으면 고정하지 않고, 도착한 첫 렌더에서 계산', async () => {
    const { ds, set, get } = source({ spaces: [space({ unreadCount: 1 })], messages: [], connection: 'connected' });
    await enter(ds);
    set({ ...get(), messages: [msg('a', 1, DAY2), msg('b', 2, DAY2)] });
    expect(document.querySelector('.new-messages-divider + [data-message-id="b"]')).not.toBeNull();
  });

  it('catch-up 중에는 계산을 보류한다', async () => {
    const { ds, set, get } = source({ spaces: [space({ unreadCount: 1 })], messages: [msg('a', 1, DAY2)], connection: 'catching-up' });
    await enter(ds);
    expect(document.querySelectorAll('.new-messages-divider')).toHaveLength(0);
    set({ ...get(), messages: [msg('a', 1, DAY2), msg('b', 2, DAY2)], connection: 'connected' });
    expect(document.querySelector('.new-messages-divider + [data-message-id="b"]')).not.toBeNull();
  });
});

describe('헤더·스레드 요약', () => {
  it('대화 멤버 목록을 이미 받았으면 「채널 · 멤버 n」, 없으면 「채널」', async () => {
    const members = [
      { id: 'u1', displayName: '홍길동' },
      { id: 'u2', displayName: '김철수' },
      { id: 'u3', displayName: '이영희' },
    ];
    const { ds } = source(
      { spaces: [space()], messages: [msg('a', 1, DAY2)], connection: 'connected' },
      { joinChannel: () => Promise.resolve({ ok: true, value: 'c1' }), listConversationMembers: () => Promise.resolve({ ok: true, value: members }) },
    );
    await enter(ds);
    expect(await screen.findByText('채널 · 멤버 3')).toBeTruthy();
  });

  it('「↳」는 장식(aria-hidden) — 접근 이름은 「답글 n」 그대로', async () => {
    const { ds } = source({ spaces: [space()], messages: [msg('a', 1, DAY2, { replyCount: 2 })], connection: 'connected' });
    await enter(ds);
    const button = document.querySelector('[data-thread-summary-for="a"]') as HTMLElement;
    expect(button.querySelector('.thread-summary-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: '답글 2' })).toBe(button);
  });
});

describe('compact 설치 안내 카드(시안 04)', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
  const showList = (ua: string, standalone: boolean) => {
    installViewport(390);
    const media = window.matchMedia;
    vi.stubGlobal('navigator', { ...navigator, userAgent: ua });
    window.matchMedia = ((q: string) =>
      q === '(display-mode: standalone)' ? ({ matches: standalone, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList) : media(q)) as typeof window.matchMedia;
    const { ds } = source({ spaces: [space()], messages: [], connection: 'connected' });
    render(<AppShell dataSource={ds} />);
  };

  it('iOS 브라우저: 공간 목록 위에 카드', () => {
    showList(ios, false);
    const card = document.querySelector('.app-shell > .install-card');
    expect(card?.textContent).toContain('홈 화면에 추가');
    expect(card?.nextElementSibling?.classList.contains('sidebar')).toBe(true);
  });

  it('이미 설치된 standalone이면 숨김', () => {
    showList(ios, true);
    expect(document.querySelector('.install-card')).toBeNull();
  });

  it('설치 수단이 없는 브라우저(데스크톱 비지원)면 숨김', () => {
    showList('Mozilla/5.0 (X11; Linux x86_64)', false);
    expect(document.querySelector('.install-card')).toBeNull();
  });

  it('beforeinstallprompt를 받으면 「앱으로 설치」 버튼', () => {
    showList('Mozilla/5.0 (Linux; Android 15)', false);
    const event = Object.assign(new Event('beforeinstallprompt'), { prompt: () => Promise.resolve() });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByRole('button', { name: '앱으로 설치' }).closest('.install-card')).not.toBeNull();
  });
});
