/** 대화 멤버십 이벤트. W-09 실시간 계층이 구독해 나간 사용자의 기존 구독을 끊는다(FR-CONV-02 5초). */
export type MembershipEndedListener = (conversationId: string, userId: string) => void;

/** 봇 채널 추가(BOT_CHANNEL_SPEC §4-3). 실시간 계층이 영향받는 봇 연결에 `membership.changed joined`를 보낸다. */
export type MembershipStartedListener = (conversationId: string, userId: string) => void;

/**
 * 채널 삭제(FR-CONV-06, commit 후 발행). 실시간 계층이 그 시점 활성 멤버의 기존 구독을 끊고,
 * 사람 연결에는 `conversation.deleted`, 봇 연결에는 `membership.changed left`를 보낸다.
 */
export type ConversationDeletedListener = (conversationId: string, memberIds: readonly string[]) => void;

export interface ConversationEvents {
  conversationDeleted(conversationId: string, memberIds: readonly string[]): void;
  onConversationDeleted(listener: ConversationDeletedListener): () => void;
  membershipEnded(conversationId: string, userId: string): void;
  onMembershipEnded(listener: MembershipEndedListener): () => void;
  membershipStarted(conversationId: string, userId: string): void;
  onMembershipStarted(listener: MembershipStartedListener): () => void;
}

export function createConversationEvents(): ConversationEvents {
  const listeners = new Set<MembershipEndedListener>();
  const started = new Set<MembershipStartedListener>();
  const deleted = new Set<ConversationDeletedListener>();
  return {
    conversationDeleted(conversationId, memberIds) {
      for (const listener of deleted) listener(conversationId, memberIds);
    },
    onConversationDeleted(listener) {
      deleted.add(listener);
      return () => deleted.delete(listener);
    },
    membershipStarted(conversationId, userId) {
      for (const listener of started) listener(conversationId, userId);
    },
    onMembershipStarted(listener) {
      started.add(listener);
      return () => started.delete(listener);
    },
    membershipEnded(conversationId, userId) {
      for (const listener of listeners) listener(conversationId, userId);
    },
    onMembershipEnded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
