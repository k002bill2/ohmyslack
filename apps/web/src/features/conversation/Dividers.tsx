import { CONVERSATION_DESIGN_COPY as COPY } from '../../ui/copy.js';

const DAY = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('ko-KR', { weekday: 'long' });

/** `Intl.DateTimeFormat('ko-KR')` 기준 `YYYY-MM-DD`(UI_STATES §2-4 CMP-10, D §7-5). */
export function dayKey(date: Date): string {
  const parts = DAY.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** CMP-10 표시 문구: 「오늘」 / 「어제」 / `YYYY-MM-DD`. */
export function dateSeparatorText(at: Date, now: Date): string {
  const key = dayKey(at);
  if (key === dayKey(now)) return COPY.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return key === dayKey(yesterday) ? COPY.yesterday : key;
}

export interface DateSeparatorProps {
  /** 그 날 첫 메시지의 ISO 시각. */
  readonly at: string;
  /** 기준 시각(테스트 주입용, 기본 현재). */
  readonly now?: Date;
}

/** CMP-10 DateSeparator(시안 01·05): 큰 날짜 + 요일 보조. 목록(`ul`) 안에 들어가는 항목. */
export function DateSeparator({ at, now = new Date() }: DateSeparatorProps) {
  const date = new Date(at);
  return (
    <li className="date-separator" role="separator">
      <span className="date-separator-day">{dateSeparatorText(date, now)}</span>
      <span className="date-separator-weekday">{WEEKDAY.format(date)}</span>
    </li>
  );
}

/** CMP-09 NewMessagesDivider(시안 01): 빨간 알약 라벨 + 선. 위치 판정은 목록(MessageList) 책임(UI_STATES §2-4). */
export function NewMessagesDivider() {
  return (
    <li className="new-messages-divider" role="separator" aria-label={COPY.newMessages}>
      <span className="new-messages-label">{COPY.newMessages}</span>
    </li>
  );
}
