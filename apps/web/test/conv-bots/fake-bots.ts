/** FR-BOT-11 가짜 DataSource: 메모리 구현 + 계정·멤버·채널 멤버·봇 추가/제거(호출 기록). */
import { createMemoryDataSource, type ActionResult, type DataSource, type Member } from '../../src/data';
import { seed } from '../helpers/fixtures.js';

export const BOT = { id: 'u-jarvis', displayName: 'Jarvis', role: 'member', kind: 'bot' } as const satisfies Member;
export const OWNER = { id: 'u-owner', displayName: '영', role: 'owner' } as const;
export const PEER = { id: 'u-peer', displayName: '홍길동', role: 'member' } as const;

export interface FakeBotWorld {
  readonly ds: DataSource;
  readonly calls: string[];
  /** 대화별 멤버 ID(봇 포함). */
  readonly members: Map<string, Set<string>>;
  /** 다음 추가·제거 요청이 돌려줄 실패. */
  fail: { add?: ActionResult<null>; remove?: ActionResult<null> };
}

export function fakeBotWorld(role: 'owner' | 'member' = 'owner'): FakeBotWorld {
  const base = createMemoryDataSource(seed({ account: { id: OWNER.id, displayName: OWNER.displayName, role } }));
  const directory: readonly Member[] = [{ ...OWNER, role }, PEER, BOT];
  const world: FakeBotWorld = {
    ds: base,
    calls: [],
    members: new Map([
      ['c1', new Set([OWNER.id, PEER.id])],
      ['c2', new Set([OWNER.id])],
      ['d1', new Set([OWNER.id, PEER.id])],
    ]),
    fail: {},
  };
  const ok: ActionResult<null> = { ok: true, value: null };
  const ds: DataSource = {
    ...base,
    joinChannel: (id) => Promise.resolve({ ok: true, value: id }),
    leaveChannel: () => Promise.resolve(ok),
    listMembers: () => Promise.resolve({ ok: true, value: directory }),
    listConversationMembers: (id) =>
      Promise.resolve({
        ok: true,
        value: [...(world.members.get(id) ?? [])].map((uid) => {
          const m = directory.find((d) => d.id === uid);
          return { id: uid, displayName: m?.displayName ?? uid, ...(m?.kind === 'bot' ? { bot: true } : {}) };
        }),
      }),
    addBotToChannel: (id, botId) => {
      world.calls.push(`POST /api/conversations/${id}/bots ${botId}`);
      if (world.fail.add !== undefined) return Promise.resolve(world.fail.add);
      world.members.get(id)?.add(botId);
      return Promise.resolve(ok);
    },
    removeBotFromChannel: (id, botId) => {
      world.calls.push(`DELETE /api/conversations/${id}/bots/${botId}`);
      if (world.fail.remove !== undefined) return Promise.resolve(world.fail.remove);
      world.members.get(id)?.delete(botId);
      return Promise.resolve(ok);
    },
  };
  return Object.assign(world, { ds });
}
