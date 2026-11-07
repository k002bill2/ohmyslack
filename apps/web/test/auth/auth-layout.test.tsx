/** 로그인 전 화면 스타일 훅(auth.css): 화면 래퍼 + 카드 클래스. 문구·접근 이름은 기존 테스트가 고정한다. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteAccept, LoginForm } from '../../src/features/auth/index.js';

afterEach(cleanup);

function card(el: HTMLElement): HTMLElement | null {
  const found = el.closest('.auth-card');
  return found instanceof HTMLElement ? found : null;
}

describe('auth 화면 레이아웃 클래스', () => {
  it('LoginForm은 .auth-screen 안의 form.auth-card다', () => {
    render(<LoginForm onLogin={vi.fn()} onSuccess={vi.fn()} />);
    const form = card(screen.getByRole('heading', { level: 1 }));
    expect(form?.tagName).toBe('FORM');
    expect(form?.parentElement?.className).toBe('auth-screen');
  });

  it('InviteAccept 폼과 사용 불가 화면도 카드 안에 있다', () => {
    const base = { clearHash: vi.fn(), onAccept: vi.fn(), onSuccess: vi.fn() };
    render(<InviteAccept {...base} readHash={() => '#t=abc'} />);
    expect(card(screen.getByRole('heading', { level: 1 }))?.tagName).toBe('FORM');
    cleanup();
    render(<InviteAccept {...base} readHash={() => ''} />);
    const unusable = card(screen.getByRole('link'));
    expect(unusable?.tagName).toBe('DIV');
    expect(unusable?.parentElement?.className).toBe('auth-screen');
  });
});
