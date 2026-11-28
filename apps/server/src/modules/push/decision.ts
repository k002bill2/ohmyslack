/**
 * 봇 스레드 답글이 영환님의 결정을 요청하는지 판정한다(TRD §6-2). 첫 비어 있지 않은 줄만 본다.
 * ① Hermes 승인 요청 고정 문구 ② clarify 질문(❓) ③ Jarvis 명시 표식 `[결정 필요]`.
 * 선형 스캔만 쓴다(정규식 백트래킹 없음) — 본문 최대 길이에서도 즉시 끝난다.
 */
const WARNING = '\u{26A0}';
const QUESTION = '\u{2753}';
const VS16 = '\u{FE0F}';
const APPROVAL_TAIL = ' **Hermes wants to run a command that needs your OK**';
const DECISION_MARK = '[결정 필요]';

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function firstLine(body: string): string {
  let start = 0;
  while (start < body.length && isBlank(body.charAt(start))) start += 1;
  const end = body.indexOf('\n', start);
  return body.slice(start, end === -1 ? body.length : end);
}

/** 이모지 뒤 선택적 VS16을 건너뛴 위치. 이모지로 시작하지 않으면 -1. */
function afterEmoji(line: string, emoji: string): number {
  if (!line.startsWith(emoji)) return -1;
  const next = emoji.length;
  return line.startsWith(VS16, next) ? next + VS16.length : next;
}

export function isDecisionRequest(body: string | null): boolean {
  if (body === null) return false;
  const line = firstLine(body);
  if (line.length === 0) return false;
  if (afterEmoji(line, QUESTION) !== -1) return true;
  const warn = afterEmoji(line, WARNING);
  if (warn !== -1 && line.startsWith(APPROVAL_TAIL, warn)) return true;
  return line.includes(DECISION_MARK);
}
