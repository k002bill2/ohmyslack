/** 초대 만료 시각 — 서버 ISO 문자열을 Asia/Seoul 날짜·시각으로(실행 환경 TZ와 무관). */
const EXPIRY = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

export function formatExpiry(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : EXPIRY.format(at);
}

/** 초대 링크(D §10-2 S1 `https://<host>/invite#t=…`). token은 프래그먼트에만 — 서버 로그·Referer에 남지 않는다. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite#t=${encodeURIComponent(token)}`;
}
