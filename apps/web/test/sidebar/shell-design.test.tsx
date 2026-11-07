/**
 * W-11a 디자인 셸(시안 01·04·07): 사이드바 헤더·섹션 「채널」/「대화」·계정 카드, 연결 배너 장식 아이콘.
 * 모양은 Jarvis 시각 확인이 판정하고, 여기서는 구조·접근 이름·문구 불변만 고정한다.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Space } from '../../src/data';
import { Sidebar } from '../../src/features/sidebar';
import { CONNECTION_TEXT, ConnectionBanner } from '../../src/features/sync';
import { APP_NAME } from '../../src/ui/copy.js';

afterEach(cleanup);

const space = (id: string, kind: Space['kind'], extra: Partial<Space> = {}): Space => ({
  id, kind, name: id, unreadCount: 0, mentionCount: 0, unreadThreadCount: 0, ...extra,
});
const spaces = [space('dev', 'channel', { unreadCount: 2, mentionCount: 2 }), space('kim', 'dm'), space('ideas', 'channel', { unreadThreadCount: 1 })];
const account = { id: 'u1', displayName: '강영환', role: 'owner' as const };

describe('사이드바 셸(시안 01·04)', () => {
  it('앱 이름 헤더 + 섹션 「채널」·「대화」로 나누고 종류 안 순서는 유지', () => {
    render(<Sidebar spaces={spaces} selectedId="dev" collapsed={false} onSelect={() => {}} account={account} />);
    const nav = screen.getByRole('navigation', { name: '공간' });
    expect(within(nav).getByText(APP_NAME)).toBeTruthy();
    const channels = within(nav).getByRole('region', { name: '채널' });
    const dms = within(nav).getByRole('region', { name: '대화' });
    expect(within(channels).getAllByRole('button').map((b) => b.dataset['spaceId'])).toEqual(['dev', 'ideas']);
    expect(within(dms).getAllByRole('button').map((b) => b.dataset['spaceId'])).toEqual(['kim']);
    // 선택 항목 aria-current, 새 답글 표시는 접근 이름 유지.
    expect(within(channels).getByRole('button', { current: 'page' }).dataset['spaceId']).toBe('dev');
    expect(within(channels).getByRole('img', { name: '새 답글 있는 스레드 1개' })).toBeTruthy();
  });

  it('계정 카드: 표시 이름 + 역할(관리자), 이니셜은 장식(aria-hidden, 텍스트 노드 없음)', () => {
    const { container } = render(<Sidebar spaces={spaces} selectedId={null} collapsed={false} onSelect={() => {}} account={account} />);
    expect(screen.getByText('강영환')).toBeTruthy();
    expect(screen.getByText('관리자')).toBeTruthy();
    const avatar = container.querySelector('.account-avatar');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.getAttribute('data-initial')).toBe('강');
    expect(avatar?.textContent).toBe('');
  });

  it('compact는 헤더 제목 「공간」(시안 04)', () => {
    render(<Sidebar spaces={spaces} selectedId={null} collapsed={false} compact onSelect={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: '공간' })).toBeTruthy();
  });

  it('빈 섹션은 렌더하지 않는다', () => {
    render(<Sidebar spaces={[space('dev', 'channel')]} selectedId={null} collapsed={false} onSelect={() => {}} />);
    expect(screen.queryByRole('region', { name: '대화' })).toBeNull();
  });
});

describe('연결 배너(시안 02·07)', () => {
  it('아이콘은 장식이고 문구는 정본 그대로', () => {
    const { container, rerender } = render(<ConnectionBanner state="offline" />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(CONNECTION_TEXT.offline);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<ConnectionBanner state="connected" />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
