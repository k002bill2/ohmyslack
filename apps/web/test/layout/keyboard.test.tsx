import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { DOUBLE_ESC_HINT } from '../../src/features/thread';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

function current(): string | null {
  return screen.getByRole('navigation', { name: '공간' }).querySelector('[aria-current="page"] .space-name')?.textContent ?? null;
}

describe('FR-CLIENT-01 키보드', () => {
  it('FR-CLIENT-01 디자인 정본의 wide와 medium 구간 각각에서 키보드만으로 공간 전환·전송·스레드 닫기를 하고 포커스가 원래 항목으로 돌아온다', async () => {
    for (const width of [1280, 800]) {
      installViewport(width);
      const user = userEvent.setup();
      render(<App dataSource={memory()} />);

      // R4: wide는 사이드바 헤더 「사이드바 접기」가 첫 정류장, 그다음 「이동…」(전환기), 그다음 첫 공간 → Enter.
      await user.tab();
      if (width === 1280) {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: '사이드바 접기' }));
        await user.tab();
      }
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '공간 이동 (Ctrl/⌘+K)' }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'general' }));
      await user.keyboard('{Enter}');
      expect(current()).toBe('general');

      // 공간 전환(디자인 §7-3 Ctrl+Alt+↑/↓) → 새 공간의 작성기(F4).
      await user.keyboard('{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}');
      expect(current()).toBe('dev');
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#dev에 메시지 작성' }));
      await user.keyboard('{Control>}{Alt>}{ArrowUp}{/Alt}{/Control}');
      expect(current()).toBe('general');
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '#general에 메시지 작성' }));
      // Shift: 읽지 않은 공간만.
      await user.keyboard('{Control>}{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}{/Control}');
      expect(current()).toBe('dev');
      await user.keyboard('{Control>}{Alt>}{ArrowUp}{/Alt}{/Control}');
      expect(current()).toBe('general');

      // 전송: Enter → 목록에 추가, 작성기 비움·포커스 유지.
      await user.keyboard('키보드 전송{Enter}');
      const composer = screen.getByRole('textbox', { name: '#general에 메시지 작성' });
      expect(screen.getByText('키보드 전송')).toBeTruthy();
      expect(document.activeElement).toBe(composer);
      expect((composer as HTMLTextAreaElement).value).toBe('');

      // 스레드: Shift+Tab → 방금 보낸 메시지 툴바(R4: 답글 · [수정] · 더보기)를 거슬러 「답글」 → Enter → 답글 작성기.
      await user.tab({ shift: true });
      expect(document.activeElement?.getAttribute('aria-label')).toBe('더보기');
      while (!(document.activeElement as HTMLElement).hasAttribute('data-reply-for')) await user.tab({ shift: true });
      const reply = document.activeElement as HTMLElement;
      expect(reply.textContent).toBe('답글');
      await user.keyboard('{Enter}');
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '답글 작성' }));

      if (width === 1280) {
        // wide + 입력 있음: Esc 1회는 안내만, 1.5초 안 2회째에 닫기.
        await user.keyboard('초안');
        await user.keyboard('{Escape}');
        expect(screen.getByRole('complementary', { name: '스레드' })).toBeTruthy();
        expect(screen.getByText(DOUBLE_ESC_HINT)).toBeTruthy();
      }
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary', { name: '스레드' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: '스레드' })).toBeNull();
      expect(document.activeElement).toBe(reply);
      cleanup();
    }
  });
});
