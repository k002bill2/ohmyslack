/** Codex r1 P2 회귀: 멘션 구간 추적·초안 복원·나가기 즉시 반영·다른 기기 재참여. */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, createDraftStore } from '../../src/features/conversation';
import { mentionIdsIn } from '../../src/features/conversation/mention.js';
import { CONV, flush, setup, summary } from '../sync/fake-server.js';

afterEach(cleanup);

describe('mentionIdsIn 구간 추적', () => {
  it('@Bob 삭제 후 남은 @Bobby가 Bob을 끌고 오지 않는다', () => {
    const sel = [
      { id: 'bob', displayName: 'Bob' },
      { id: 'bobby', displayName: 'Bobby' },
    ];
    expect(mentionIdsIn('hi @Bobby ', sel)).toEqual(['bobby']);
    expect(mentionIdsIn('@Bob, @Bobby', sel)).toEqual(['bobby']);
    expect(mentionIdsIn('@Bob @Bobby', sel)).toEqual(['bob', 'bobby']);
  });
  it('같은 표시 이름 두 사용자 중 하나만 남으면 하나만', () => {
    const sel = [
      { id: 'k1', displayName: 'Kim' },
      { id: 'k2', displayName: 'Kim' },
    ];
    expect(mentionIdsIn('@Kim @Kim', sel)).toEqual(['k1', 'k2']);
    expect(mentionIdsIn('@Kim', sel)).toEqual(['k2']);
  });
});

describe('초안과 함께 멘션 복원', () => {
  it('재마운트 후에도 선택한 멘션 ID를 보낸다', () => {
    const store = createDraftStore();
    const cands = { candidates: [{ id: 'u-b', displayName: 'B' }] };
    const first = vi.fn();
    const view = render(<Composer label="작성" onSend={first} draft={{ store, key: 'c1' }} mentions={cands} />);
    const box = () => document.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: '@' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    view.unmount();
    const onSend = vi.fn();
    render(<Composer label="작성" onSend={onSend} draft={{ store, key: 'c1' }} mentions={cands} />);
    expect(box().value).toBe('@B ');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('@B ', ['u-b']);
  });
});

describe('http-source 나가기 상태', () => {
  it('DELETE 성공 뒤 목록 GET이 실패해도 나간 채널로 표시', async () => {
    const { server, ds } = setup();
    await ds.start();
    server.on(`DELETE /api/conversations/${CONV}/membership`, () => ({ status: 204 }));
    server.on('GET /api/conversations', () => ({ status: 500 }));
    const res = await ds.leaveChannel?.(CONV);
    expect(res?.ok).toBe(true);
    expect(ds.getSnapshot().spaces.find((s) => s.id === CONV)?.left).toBe(true);
  });

  it('다른 기기에서 다시 참여해 목록에 돌아오면 나가기 기억을 지우고 다시 구독한다', async () => {
    const { server, ds } = setup();
    await ds.start();
    let left = false;
    server.on(`DELETE /api/conversations/${CONV}/membership`, () => {
      left = true;
      return { status: 204 };
    });
    server.on('GET /api/conversations', () => ({ status: 200, body: { conversations: left ? [] : [summary()], next_cursor: null } }));
    await ds.leaveChannel?.(CONV);
    expect(ds.getSnapshot().spaces[0]?.left).toBe(true);
    left = false;
    await ds.resume();
    expect(ds.getSnapshot().spaces).toHaveLength(1);
    expect(ds.getSnapshot().spaces[0]?.left).toBeUndefined();
    const before = server.log.filter((l) => l === 'ws conversation.subscribe').length;
    await act(async () => {
      ds.open?.(CONV);
      await flush();
    });
    expect(server.log.filter((l) => l === 'ws conversation.subscribe').length).toBe(before + 1);
  });
});
