/**
 * W-11b 시안 반영으로 새로 필요한 문구(정본 COPY 미확정 — Jarvis 결정 대기, REPORT 「문구 차이」).
 * `ui/copy.ts`는 병렬 레인 충돌 방지로 수정하지 않는다.
 */
export const CONVERSATION_DESIGN_COPY = {
  /** 시안 01 「나를 멘션」 라벨(CMP-07 멘션 강조). */
  mentionedSelf: '나를 멘션',
  /** UI_STATES §2-4 CMP-09. */
  newMessages: '여기부터 새 메시지',
  /** UI_STATES §2-4 CMP-10. */
  today: '오늘',
  yesterday: '어제',
} as const;
