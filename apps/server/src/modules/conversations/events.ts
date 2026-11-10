/** 대화 멤버십 이벤트. W-09 실시간 계층이 구독해 나간 사용자의 기존 구독을 끊는다(FR-CONV-02 5초). */
export type MembershipEndedListener = (conversationId: string, userId: string) => void;

/** 봇 채널 추가(BOT_CHANNEL_SPEC §4-3). 실시간 계층이 영향받는 봇 연결에 `membership.changed joined`를 보낸다. */
export type MembershipStartedListener = (conversationId: string, userId: string) => void;

export interface ConversationEvents {
  membershipEnded(conversationId: string, userId: string): void;
  onMembershipEnded(listener: MembershipEndedListener): () => void;
  membershipStarted(conversationId: string, userId: string): void;
  onMembershipStarted(listener: MembershipStartedListener): () => void;
}

export function createConversationEvents(): ConversationEvents {
  const listeners = new Set<MembershipEndedListener>();
  const started = new Set<MembershipStartedListener>();
  return {
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
