/** 읽음 위치 판정 보조(FR-SYNC-03): 서버 seq가 있는 마지막 메시지의 seq. 전송 대기 항목은 제외한다. */
export function lastServerSeq(messages: readonly { readonly seq?: number; readonly pending?: unknown }[]): number | undefined {
  let max: number | undefined;
  for (const m of messages) if (m.pending === undefined && m.seq !== undefined && (max === undefined || m.seq > max)) max = m.seq;
  return max;
}

/** 맨 아래로 보는 여유(px) — CMP-06 하단 고정(`conversation/pin-bottom` PIN_THRESHOLD_PX)과 같은 값. */
const SEEN_THRESHOLD_PX = 24;

/** 스크롤 상자가 맨 아래(마지막 항목이 보임)인가. */
export function scrolledToBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SEEN_THRESHOLD_PX;
}
