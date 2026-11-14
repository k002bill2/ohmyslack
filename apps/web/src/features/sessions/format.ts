import type { DeviceSession } from '../../data';
import { dateSeparatorText } from '../conversation';
import { SESSION_LIST_COPY } from '../../ui/copy.js';

const TIME = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

/** G-66 {시각}: 오늘·어제면 「오늘 오후 3:12」, 그 전은 `YYYY-MM-DD`(CMP-10 날짜 판정 재사용). 해석 불가면 원문. */
export function lastUsedWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = dateSeparatorText(at, now);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : `${day} ${TIME.format(at)}`;
}

/** G-65 화면 라벨: 서버 라벨 그대로, null이면 「알 수 없는 기기」. */
export function deviceLabel(session: DeviceSession): string {
  return session.deviceLabel ?? SESSION_LIST_COPY.unknownDevice;
}

/** UI-D16 정렬: 이 기기 맨 위 → 나머지 `last_seen_at` 내림차순. 입력은 바꾸지 않는다. */
export function sortSessions(sessions: readonly DeviceSession[]): readonly DeviceSession[] {
  const time = (s: DeviceSession) => {
    const t = Date.parse(s.lastSeenAt);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...sessions].sort((a, b) => (a.current === b.current ? time(b) - time(a) : a.current ? -1 : 1));
}

/** 다른 기기 행 버튼 접근 이름(G-67). 같은 라벨 행이 둘 이상이면 「, 마지막 사용 {시각}」을 붙인다(G-65). */
export function logoutName(session: DeviceSession, all: readonly DeviceSession[], now: Date): string {
  const label = deviceLabel(session);
  const same = all.filter((s) => deviceLabel(s) === label).length;
  const base = SESSION_LIST_COPY.logoutName(label);
  return same > 1 ? `${base}${SESSION_LIST_COPY.lastUsedSuffix(lastUsedWhen(session.lastSeenAt, now))}` : base;
}

/** 행 아이콘 종류(장식): 휴대 기기 라벨·라벨 없음은 `smartphone`, 그 외 `laptop`. */
export function deviceIconKind(session: DeviceSession): 'smartphone' | 'laptop' {
  const label = session.deviceLabel;
  return label === null || /iphone|ipad|android|phone|mobile/i.test(label) ? 'smartphone' : 'laptop';
}
