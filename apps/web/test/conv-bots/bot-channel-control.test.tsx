/**
 * FR-BOT-11 채널 헤더 봇 컨트롤(BOT_CHANNEL_SPEC §3-1·§3-4·§3-5, COPY_GAPS G-43–47).
 * AppShell + 가짜 DataSource로 owner·채널·참여 중일 때만 보이는지, 추가 → 멘션 후보 배지, 제거 확인 Dialog → DELETE, 실패 표시를 본다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../src/features/layout';
import { failureText } from '../../src/features/spaces';
import { BOT_BADGE_TEXT, BOT_CHANNEL_COPY } from '../../src/ui/copy.js';
import { BOT, fakeBotWorld } from './fake-bots.js';
import { headerMenuItems, selectHeaderMenuItem } from './header-menu.js';

afterEach(cleanup);

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};
const nav = () => screen.getByRole('navigation', { name: '공간' });
const ADD = BOT_CHANNEL_COPY.add(BOT.displayName);
const REMOVE = BOT_CHANNEL_COPY.title(BOT.displayName);
// menu-bots-touch-focus: 봇 추가·제거는 머리 버튼이 아니라 「대화 더보기」 메뉴 항목이다.
const hasAdd = () => headerMenuItems().includes(ADD);
const hasRemove = () => headerMenuItems().includes(REMOVE);

async function openSpace(name: string) {
  fireEvent.click(within(nav()).getByRole('button', { name }));
  await settle();
}

function mentionOptions(): string[] {
  const box = screen.getByLabelText('#general에 메시지 작성') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '@' } });
  const opts = screen.queryAllByRole('option').map((o) => o.textContent ?? '');
  fireEvent.change(box, { target: { value: '' } });
  return opts;
}

describe('FR-BOT-11 채널 헤더 봇 컨트롤', () => {
  it('FR-BOT-11 채널 헤더 봇 컨트롤은 owner에게만 보이고 봇을 추가하면 멘션 후보에 봇 배지와 함께 나타난다', async () => {
    const w = fakeBotWorld('owner');
    render(<AppShell dataSource={w.ds} />);
    await settle();
    await openSpace('general');
    expect(hasRemove()).toBe(false);
    expect(mentionOptions()).toEqual(['홍길동']);
    expect(screen.getByText('채널 · 멤버 2')).toBeTruthy();

    selectHeaderMenuItem(ADD);
    await settle();
    expect(w.calls).toEqual([`POST /api/conversations/c1/bots ${BOT.id}`]);
    // 추가 후: 멤버 수 갱신 + 멘션 후보에 봇 배지 + 컨트롤은 제거로 바뀐다.
    expect(screen.getByText('채널 · 멤버 3')).toBeTruthy();
    expect(mentionOptions()).toContain(`${BOT.displayName} ${BOT_BADGE_TEXT}`);
    expect(hasAdd()).toBe(false);
    expect(hasRemove()).toBe(true);
  });

  it('제거는 확인 Dialog를 거쳐 DELETE를 부르고, 취소하면 요청이 없다', async () => {
    const w = fakeBotWorld('owner');
    w.members.get('c1')?.add(BOT.id);
    render(<AppShell dataSource={w.ds} />);
    await settle();
    await openSpace('general');

    selectHeaderMenuItem(REMOVE);
    let dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    expect(within(dialog).getByText(BOT_CHANNEL_COPY.body)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(w.calls).toEqual([]);

    selectHeaderMenuItem(REMOVE);
    dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    expect(w.calls).toEqual([`DELETE /api/conversations/c1/bots/${BOT.id}`]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hasAdd()).toBe(true);
    expect(mentionOptions()).toEqual(['홍길동']);
  });

  it('추가·제거 실패는 기존 오류 표시(ErrorState)로 보이고 상태는 그대로다', async () => {
    const w = fakeBotWorld('owner');
    w.fail.add = { ok: false, status: 404 };
    render(<AppShell dataSource={w.ds} />);
    await settle();
    await openSpace('general');

    selectHeaderMenuItem(ADD);
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(BOT_CHANNEL_COPY.addFailed);
    expect(alert.textContent).toContain(failureText({ status: 404 }));
    expect(hasAdd()).toBe(true);

    // 제거 실패: Dialog 안에 원인, Dialog는 열린 채.
    cleanup();
    const r = fakeBotWorld('owner');
    r.fail.remove = { ok: false, status: 'network' };
    r.members.get('c1')?.add(BOT.id);
    render(<AppShell dataSource={r.ds} />);
    await settle();
    await openSpace('general');
    selectHeaderMenuItem(REMOVE);
    const dialog = screen.getByRole('dialog', { name: BOT_CHANNEL_COPY.title(BOT.displayName) });
    fireEvent.click(within(dialog).getByRole('button', { name: BOT_CHANNEL_COPY.confirm }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(failureText({ status: 'network' }));
    expect(r.calls).toEqual([`DELETE /api/conversations/c1/bots/${BOT.id}`]);
    expect(hasRemove()).toBe(true);
  });

  it('일반 멤버·DM에서는 봇 컨트롤을 렌더하지 않는다', async () => {
    const member = fakeBotWorld('member');
    render(<AppShell dataSource={member.ds} />);
    await settle();
    await openSpace('general');
    expect(hasAdd()).toBe(false);
    expect(hasRemove()).toBe(false);
    cleanup();

    const owner = fakeBotWorld('owner');
    render(<AppShell dataSource={owner.ds} />);
    await settle();
    await openSpace('홍길동');
    expect(hasAdd()).toBe(false);
    expect(hasRemove()).toBe(false);
    await openSpace('general');
    expect(hasAdd()).toBe(true);
  });
});

describe('Codex L3 P2 회귀', () => {
  it('멤버 조회가 실패하면 봇이 이미 있어도 「봇 추가」로 오인하지 않고 컨트롤을 숨긴다', async () => {
    const w = fakeBotWorld('owner');
    w.members.get('c1')?.add(BOT.id);
    const ds = { ...w.ds, listConversationMembers: () => Promise.resolve({ ok: false, status: 503 } as const) };
    render(<AppShell dataSource={ds} />);
    await settle();
    await openSpace('general');
    expect(hasAdd()).toBe(false);
    expect(hasRemove()).toBe(false);
  });
});

describe('COPY_GAPS G-43–47(★ Jarvis 초안 2026-11-10) — 정본 문구 리터럴 비교', () => {
  it('상수가 확정안과 같다', () => {
    expect(BOT_CHANNEL_COPY.add('Jarvis')).toBe('봇 추가: Jarvis');
    expect(BOT_CHANNEL_COPY.title('Jarvis')).toBe('봇 제거: Jarvis');
    expect(BOT_CHANNEL_COPY.body).toBe('제거하면 이 봇은 이 채널의 새 메시지를 받지 않고 이 채널에 글을 쓸 수 없습니다. 다시 추가할 수 있습니다.');
    expect(BOT_CHANNEL_COPY.confirm).toBe('제거');
    expect(BOT_CHANNEL_COPY.addFailed).toBe('봇을 추가하지 못했습니다.');
  });
});
