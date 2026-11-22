import { describe, expect, it } from 'vitest';
import { createConversationEvents } from '../../src/modules/conversations/events.js';
import { createConversationsService } from '../../src/modules/conversations/service.js';
import type { AccessRow, AddBotResult, ConversationsStore, DeletedMember } from '../../src/modules/conversations/store.js';

/** manage_bots 판정 순서·봇 추가/제거 이벤트(BOT_CHANNEL_SPEC §4-2·§4-3) 단위. 실DB는 bot-channel-membership.int. */
const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function service(row: AccessRow | undefined, add: AddBotResult = 'added', removed = true, deleted?: readonly DeletedMember[]) {
  const roles: boolean[] = [];
  const store: ConversationsStore = {
    async findAccess(_c, _u, withRole) {
      roles.push(withRole === true);
      return row;
    },
    addBot: async () => add,
    removeBot: async () => removed,
    deleteChannel: async () => deleted,
    createChannel: unused,
    discover: unused,
    join: unused,
    leave: unused,
    listMembers: unused,
    listForUser: unused,
    openDm: unused,
  };
  const events = createConversationEvents();
  const log: string[] = [];
  events.onMembershipStarted((c, u) => log.push(`joined:${c}:${u}`));
  events.onMembershipEnded((c, u) => log.push(`left:${c}:${u}`));
  events.onConversationDeleted((c, ids) => log.push(`deleted:${c}:${ids.join(',')}`));
  return { svc: createConversationsService({ store, events, clock: () => 0 }), roles, log };
}

const status = (p: Promise<unknown>): Promise<number | 'ok'> =>
  p.then(
    () => 'ok' as const,
    (e: { statusCode?: number }) => e.statusCode ?? -1,
  );

describe('manage_bots 판정', () => {
  it('존재 404 → 활성 멤버 404 → owner 403 → channel 400 순서이고 역할은 manage_bots일 때만 읽는다', async () => {
    expect(await status(service(undefined).svc.assertAccess('u', 'c', 'manage_bots'))).toBe(404);
    expect(await status(service({ kind: 'dm', activeMember: false, role: 'member' }).svc.assertAccess('u', 'c', 'manage_bots'))).toBe(404);
    expect(await status(service({ kind: 'dm', activeMember: true, role: 'member' }).svc.assertAccess('u', 'c', 'manage_bots'))).toBe(403);
    expect(await status(service({ kind: 'dm', activeMember: true, role: 'owner' }).svc.assertAccess('u', 'c', 'manage_bots'))).toBe(400);
    expect(await status(service({ kind: 'channel', activeMember: true, role: 'owner' }).svc.assertAccess('u', 'c', 'manage_bots'))).toBe('ok');
    const read = service({ kind: 'channel', activeMember: true });
    expect(await status(read.svc.assertAccess('u', 'c', 'read'))).toBe('ok');
    expect(read.roles).toEqual([false]);
  });

  it('봇 추가는 새로 추가될 때만 membershipStarted, 제거는 실제로 빠질 때만 membershipEnded, 대상 오류는 404', async () => {
    const added = service(undefined, 'added');
    expect(await added.svc.addBot('c', 'b')).toBe(true);
    expect(added.log).toEqual(['joined:c:b']);
    const exists = service(undefined, 'exists', false);
    expect(await exists.svc.addBot('c', 'b')).toBe(false);
    await exists.svc.removeBot('c', 'b');
    expect(exists.log).toEqual([]);
    expect(await status(service(undefined, 'invalid_target').svc.addBot('c', 'x'))).toBe(404);
    const removed = service(undefined);
    await removed.svc.removeBot('c', 'b');
    expect(removed.log).toEqual(['left:c:b']);
  });
});

describe('FR-CONV-06 delete 판정·이벤트', () => {
  it('owner는 멤버 여부와 무관하게 채널 통과, DM은 멤버면 400·비멤버면 404, 비owner는 멤버 403·비멤버 404, 없으면 404', async () => {
    const del = (row: AccessRow | undefined) => status(service(row).svc.assertAccess('u', 'c', 'delete'));
    expect(await del(undefined)).toBe(404);
    expect(await del({ kind: 'channel', activeMember: false, role: 'owner' })).toBe('ok');
    expect(await del({ kind: 'channel', activeMember: true, role: 'owner' })).toBe('ok');
    expect(await del({ kind: 'dm', activeMember: true, role: 'owner' })).toBe(400);
    expect(await del({ kind: 'dm', activeMember: false, role: 'owner' })).toBe(404);
    expect(await del({ kind: 'channel', activeMember: true, role: 'member' })).toBe(403);
    expect(await del({ kind: 'channel', activeMember: false, role: 'member' })).toBe(404);
    expect(await del({ kind: 'dm', activeMember: true, role: 'member' })).toBe(403);
    const withRole = service({ kind: 'channel', activeMember: false, role: 'owner' });
    await withRole.svc.assertAccess('u', 'c', 'delete');
    expect(withRole.roles).toEqual([true]);
  });

  it('삭제 성공 시 그 시점 활성 멤버로 conversationDeleted를 한 번 내고, 이미 사라졌으면 404·이벤트 0', async () => {
    const ok = service(undefined, 'added', true, [
      { userId: 'h', kind: 'human' },
      { userId: 'b', kind: 'bot' },
    ]);
    await ok.svc.deleteChannel('o', 'c');
    expect(ok.log).toEqual(['deleted:c:h,b']);
    const gone = service(undefined, 'added', true, undefined);
    expect(await status(gone.svc.deleteChannel('o', 'c'))).toBe(404);
    expect(gone.log).toEqual([]);
  });
});
