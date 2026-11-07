/** CMP-04 UnreadBadge — 숫자 = 멘션 수만, 99+ 상한, 0이면 렌더 안 함(디자인 §6-2, §7-2). */
export const BADGE_CAP = 99;

export function mentionLabel(count: number): string {
  return `멘션 ${count}개`;
}

export function threadDotLabel(count: number): string {
  return `새 답글 있는 스레드 ${count}개`;
}

export function UnreadBadge({ count }: { readonly count: number }) {
  if (count <= 0) return null;
  return (
    <span className="unread-badge" role="img" aria-label={mentionLabel(count)}>
      {count > BADGE_CAP ? `${BADGE_CAP}+` : count}
    </span>
  );
}
