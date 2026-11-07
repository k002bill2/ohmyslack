/** 대화 멤버십 이벤트. W-09 실시간 계층이 구독해 나간 사용자의 기존 구독을 끊는다(FR-CONV-02 5초). */
export type MembershipEndedListener = (conversationId: string, userId: string) => void;

export interface ConversationEvents {
  membershipEnded(conversationId: string, userId: string): void;
  onMembershipEnded(listener: MembershipEndedListener): () => void;
}

export function createConversationEvents(): ConversationEvents {
  const listeners = new Set<MembershipEndedListener>();
  return {
    membershipEnded(conversationId, userId) {
      for (const listener of listeners) listener(conversationId, userId);
    },
    onMembershipEnded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
