import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App.js';
import { createDraftStore } from '../../src/features/conversation/index.js';
import { AppShell } from '../../src/features/layout/index.js';
import { memory } from '../helpers/fixtures.js';
import { installViewport } from '../helpers/viewport.js';

afterEach(cleanup);

function box(name: string): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
}

function replyFor(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-reply-for="${id}"]`);
  if (el === null) throw new Error(`답글 버튼 없음: ${id}`);
  return el;
}

describe('createDraftStore (디자인 §7-3 초안 규칙)', () => {
  it('대상별로 저장·조회하고 빈 문자열은 항목을 지우며 clear()는 전부 폐기한다', () => {
    const store = createDraftStore();
    expect(store.get('c1')).toBe('');
    store.set('c1', '가');
    store.set('m1', '나');
    expect(store.get('c1')).toBe('가');
    expect(store.get('m1')).toBe('나');
    store.set('c1', '');
    expect(store.get('c1')).toBe('');
    store.delete('m1');
    expect(store.get('m1')).toBe('');
    store.set('c2', '다');
    store.clear();
    expect(store.get('c2')).toBe('');
  });
});

describe('대상별 초안 보존·복원', () => {
  it('공간 전환 후 돌아오면 본문 작성기 초안이 복원된다', async () => {
    installViewport(1280);
    const user = userEvent.setup();
    render(<App dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.type(box('general'), '본문 초안');
    await user.click(screen.getByRole('button', { name: /^dev/ }));
    expect(box('dev').value).toBe('');
    await user.click(screen.getByRole('button', { name: 'general' }));
    expect(box('general').value).toBe('본문 초안');
  });

  it('wide: 스레드 전환·닫기 후 다시 열면 그 스레드의 초안이 복원되고 다른 스레드로 새지 않는다', async () => {
    installViewport(1280);
    const user = userEvent.setup();
    render(<App dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.click(replyFor('m1'));
    await user.type(box('답글'), '스레드 초안');
    await user.click(replyFor('m2'));
    expect(box('답글').value).toBe('');
    await user.click(replyFor('m1'));
    expect(box('답글').value).toBe('스레드 초안');
    const aside = screen.getByRole('complementary', { name: '스레드' });
    await user.click(within(aside).getByRole('button', { name: '닫기' }));
    await user.click(replyFor('m1'));
    expect(box('답글').value).toBe('스레드 초안');
  });

  it('medium: 오버레이를 Esc로 닫아도 초안이 보존되고 다시 열면 복원된다', async () => {
    installViewport(800);
    const user = userEvent.setup();
    render(<App dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.click(replyFor('m1'));
    await user.type(box('답글'), '오버레이 초안');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '스레드' })).toBeNull();
    await user.click(replyFor('m1'));
    expect(box('답글').value).toBe('오버레이 초안');
  });

  it('전송에 성공하면 그 대상의 초안 항목을 지운다', async () => {
    installViewport(1280);
    const user = userEvent.setup();
    render(<App dataSource={memory()} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.click(replyFor('m1'));
    await user.type(box('답글'), '보낼 답글{Enter}');
    expect(box('답글').value).toBe('');
    await user.click(replyFor('m2'));
    await user.click(replyFor('m1'));
    expect(box('답글').value).toBe('');
  });

  it('AppShell에 주입한 저장소의 clear()(로그아웃·401)는 모든 초안을 폐기한다', async () => {
    installViewport(1280);
    const user = userEvent.setup();
    const drafts = createDraftStore();
    render(<AppShell dataSource={memory()} drafts={drafts} />);
    await user.click(screen.getByRole('button', { name: 'general' }));
    await user.type(box('general'), '지울 초안');
    await user.click(screen.getByRole('button', { name: /^dev/ }));
    expect(drafts.get('c1')).toBe('지울 초안');
    act(() => drafts.clear());
    await user.click(screen.getByRole('button', { name: 'general' }));
    expect(box('general').value).toBe('');
  });
});
