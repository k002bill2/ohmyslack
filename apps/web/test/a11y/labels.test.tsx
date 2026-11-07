import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import type { PendingMessage } from '../../src/features/conversation';
import { buildTokensCss } from '../../src/ui/tokens.css.js';
import { T0, memory, seed } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

const FAILED: PendingMessage = {
  conversationId: 'c1', authorId: 'me', clientMessageId: 'cm-1', body: '실패한 메시지',
  status: 'failed', failure: 'retryable', serverEventSeen: false,
};

describe('FR-CLIENT-07 접근성', () => {
  it('FR-CLIENT-07 주요 조작에 접근 가능한 이름과 가시 포커스가 있고 전송 실패·연결 상태를 색 외 텍스트로 표시하며 스레드를 닫으면 원래 답글 버튼으로 포커스가 돌아온다', async () => {
    installViewport(1100);
    const base = seed();
    const ds = memory({
      connection: 'offline',
      messages: [...base.messages, { id: 'f1', conversationId: 'c1', author: '나', createdAt: T0, body: FAILED.body, replyCount: 0, pending: FAILED }],
    });
    const user = userEvent.setup();
    render(<App dataSource={ds} />);

    // 접근 가능한 이름.
    const nav = screen.getByRole('navigation', { name: '공간' });
    expect(within(nav).getByRole('img', { name: '멘션 3개' }).textContent).toBe('3');
    expect(within(nav).getByRole('img', { name: '새 답글 있는 스레드 1개' })).toBeTruthy();
    await user.click(within(nav).getByRole('button', { name: 'general' }));
    expect(within(nav).getByRole('button', { name: 'general' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('textbox', { name: '#general에 메시지 작성' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '전송' })).toBeTruthy();
    expect(screen.getAllByRole('listitem', { name: '홍길동, 오후 3:12' }).length).toBeGreaterThan(0);

    // 전송 실패·연결 상태를 색 외 텍스트로.
    expect(screen.getByRole('alert').textContent).toContain('전송 실패');
    expect(screen.getByRole('button', { name: '전송 실패 · 다시 시도' }).textContent).toBe('다시 시도');
    const banner = screen.getByRole('status', { hidden: true });
    expect(banner.textContent).toBe('연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요.');
    act(() => ds.setConnection('reconnecting'));
    expect(banner.textContent).toBe('다시 연결 중…');
    act(() => ds.setConnection('catching-up'));
    expect(banner.textContent).toBe('최신 상태 확인 중…');
    act(() => ds.setConnection('connected'));
    expect(banner.hidden).toBe(true);

    // 가시 포커스: 2px 링 + 2px 오프셋, 토큰 --focus-ring.
    const css = readFileSync(resolve(process.cwd(), 'src/features/layout/layout.css'), 'utf8');
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);[^}]*outline-offset:\s*2px;/);
    expect(buildTokensCss()).toMatch(/--focus-ring: #[0-9a-f]{6};/);

    // 스레드 열림 + 1120 미만 → 접힘: 항목 이름에 이름+상태.
    const reply = screen.getAllByRole('button', { name: '답글' })[0] as HTMLElement;
    await user.click(reply);
    expect(within(nav).getByRole('button', { name: 'dev, 멘션 3개, 새 답글 있는 스레드 1개' })).toBeTruthy();
    // 스레드를 닫으면 원래 답글 버튼으로.
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('complementary', { name: '스레드' })).toBeNull();
    expect(document.activeElement).toBe(reply);
  });
});
