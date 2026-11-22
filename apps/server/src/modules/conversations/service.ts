import { randomUUID } from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import { CHANNEL_NAME_MAX } from '../../shared.js';
import type { ConversationEvents } from './events.js';
import type { AccessRow, ConversationsStore } from './store.js';

/**
 * 대화 단위 동작. `join`만 비참여자에게 열려 있다(공개 채널 한정, DEV_DESIGN §2-4).
 * `manage_bots`: 존재 404 → 활성 멤버 404 → 워크스페이스 owner 403 → 채널 400(BOT_CHANNEL_SPEC §4-2).
 * `delete`(FR-CONV-06): 존재(삭제 제외) 404 → owner면 채널 통과·DM 400(DM 비멤버는 404) →
 * owner가 아니면 비멤버 404(존재 은폐)·멤버 403.
 */
export type AccessAction = 'read' | 'write' | 'join' | 'leave' | 'manage_bots' | 'delete';

export interface ConversationsServiceDeps {
  readonly store: ConversationsStore;
  readonly events: ConversationEvents;
  readonly clock: () => number;
}

export interface ConversationsService {
  /**
   * 대화 접근 판정의 **단일 진입점**(B2). 없는 대화·비참여·나간 사용자는 존재를 숨기고 404.
   * 미인증·비활성 계정(401)은 앞선 accountGuard가 걸러 낸다.
   */
  assertAccess(userId: string, conversationId: string, action: AccessAction): Promise<AccessRow>;
  createChannel(creatorId: string, rawName: string): Promise<{ readonly id: string }>;
  openDm(userId: string, peerId: string): Promise<{ readonly id: string }>;
  leave(userId: string, conversationId: string, access: AccessRow): Promise<void>;
  join(userId: string, conversationId: string): Promise<void>;
  /** 봇 추가(대상 검증은 저장소 트랜잭션 안). 새로 추가면 true, 이미 멤버면 false. 대상 오류 404. */
  addBot(conversationId: string, botUserId: string): Promise<boolean>;
  /** 공개 채널 소프트 삭제(접근 판정은 가드의 assertAccess 'delete'). 동시 삭제로 이미 사라졌으면 404. */
  deleteChannel(userId: string, conversationId: string): Promise<void>;
  /** 봇 제거(멱등). 실제로 빠졌을 때만 membershipEnded를 발행한다. */
  removeBot(conversationId: string, botUserId: string): Promise<void>;
  readonly store: ConversationsStore;
}

/**
 * 채널 이름 정규화(TRD §2): trim → NFC → case-fold → NFC. case-fold는 의존성 없이 lower→upper→lower로 근사한다
 * (ß·ẞ→ss, ς→σ 등 full folding의 확장 매핑을 흡수, Codex r1 P2).
 */
export function normalizeChannelName(raw: string): { readonly name: string; readonly nameNorm: string } {
  const name = raw.trim().normalize('NFC');
  return { name, nameNorm: name.toLowerCase().toUpperCase().toLowerCase().normalize('NFC') };
}

/** DM 쌍 키: 두 사용자 UUID를 정렬한 고정 표현(TRD §2). 요청 순서와 무관하다. */
export function dmPairKey(a: string, b: string): string {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${lo}:${hi}`;
}

const notFound = (): HttpError => new HttpError(404, 'not_found');

/** `delete` 판정(FR-CONV-06). owner는 멤버 여부와 무관하게 공개 채널을 지운다. DM 존재는 비멤버에게 숨긴다. */
function assertDelete(row: AccessRow): AccessRow {
  if (row.role === 'owner') {
    if (row.kind === 'channel') return row;
    throw row.activeMember ? new HttpError(400, 'invalid_request') : notFound();
  }
  if (!row.activeMember) throw notFound();
  throw new HttpError(403, 'forbidden');
}

export function createConversationsService(deps: ConversationsServiceDeps): ConversationsService {
  const { store, events, clock } = deps;
  const now = (): Date => new Date(clock());

  return {
    store,
    async assertAccess(userId, conversationId, action) {
      const row = await store.findAccess(conversationId, userId, action === 'manage_bots' || action === 'delete');
      if (row === undefined) throw notFound();
      if (action === 'delete') return assertDelete(row);
      if (action === 'join') {
        if (row.kind !== 'channel') throw notFound();
        return row;
      }
      if (!row.activeMember) throw notFound();
      if (action === 'manage_bots') {
        if (row.role !== 'owner') throw new HttpError(403, 'forbidden');
        if (row.kind !== 'channel') throw new HttpError(400, 'invalid_request');
      }
      return row;
    },
    async addBot(conversationId, botUserId) {
      const result = await store.addBot(conversationId, botUserId, now());
      if (result === 'invalid_target') throw notFound();
      if (result === 'added') events.membershipStarted(conversationId, botUserId);
      return result === 'added';
    },
    async deleteChannel(userId, conversationId) {
      const members = await store.deleteChannel(conversationId, userId, now());
      if (members === undefined) throw notFound();
      events.conversationDeleted(conversationId, members.map((m) => m.userId));
    },
    async removeBot(conversationId, botUserId) {
      if (await store.removeBot(conversationId, botUserId, now())) events.membershipEnded(conversationId, botUserId);
    },
    async createChannel(creatorId, rawName) {
      const { name, nameNorm } = normalizeChannelName(rawName);
      if (name.length === 0 || [...name].length > CHANNEL_NAME_MAX) throw new HttpError(400, 'invalid_request');
      const id = randomUUID();
      const result = await store.createChannel({ id, name, nameNorm, creatorId, at: now() });
      if (!result.ok) throw result.reason === 'name_taken' ? new HttpError(409, 'name_taken') : new HttpError(403, 'forbidden');
      return { id };
    },
    async openDm(userId, peerId) {
      if (userId.toLowerCase() === peerId.toLowerCase()) throw new HttpError(400, 'invalid_request');
      const result = await store.openDm({ id: randomUUID(), userId, peerId, pairKey: dmPairKey(userId, peerId), at: now() });
      if (!result.ok) throw new HttpError(400, 'invalid_request');
      return { id: result.id };
    },
    async join(userId, conversationId) {
      await store.join(conversationId, userId, now());
    },
    async leave(userId, conversationId, access) {
      // DM 나가기는 TRD §3에 없다(공개 채널 참여·나가기만): 입력 오류로 거부한다.
      if (access.kind !== 'channel') throw new HttpError(400, 'invalid_request');
      if (await store.leave(conversationId, userId, now())) events.membershipEnded(conversationId, userId);
    },
  };
}
