import { BOT_BADGE_TEXT } from './copy.js';

/**
 * CMP-26 BotBadge — 작성자·상대 이름 옆 「봇」 텍스트 배지(색만으로 구분하지 않음). 판정은 호출자가 서버 결정값
 * (`author_kind`·멤버 `kind`)으로만 한다 — 표시 이름으로 추정하지 않는다(ADR-001 §3-a·c).
 */
export function BotBadge() {
  return <span className="bot-badge">{BOT_BADGE_TEXT}</span>;
}

/** 접근 가능한 이름용: 이름 뒤에 배지 문구를 붙인다(봇이 아니면 이름 그대로). */
export function withBotLabel(name: string, bot: boolean): string {
  return bot ? `${name} ${BOT_BADGE_TEXT}` : name;
}
