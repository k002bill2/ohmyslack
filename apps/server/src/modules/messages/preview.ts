import { MESSAGE_PREVIEW_MAX } from '../../shared.js';

/**
 * 알림 미리보기 평문화(TRD §6-2, FR-CLIENT-05). 순수 함수.
 * 코드 펜스·인라인 코드는 구분자만 걷어 내고 안의 내용은 그대로 둔다(렌더러처럼 코드 안 서식을 해석하지 않음).
 * 코드 밖에서는 마크다운 표식(강조·링크·헤더·인용·목록 기호)을 걷어 내고, 공백을 1칸으로 접은 뒤
 * 최대 `MESSAGE_PREVIEW_MAX` code point로 자른다(초과 시 `…`). 평문이 비면 null.
 */
const FENCE_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)\n?^[ \t]*\1[ \t]*$/gm;
/** 닫히지 않은 펜스 줄(구분자만 남은 경우). */
const FENCE_LINE = /^[ \t]*(```|~~~).*$/gm;
const HEADER = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm;
const QUOTE = /^[ \t]*(?:>[ \t]?)+/gm;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm;
const LINK_OR_IMAGE = /!?\[([^\]]*)\]\([^)]*\)/g;
const BACKTICKS = /`+/g;
const DOUBLE_MARKS = /\*\*|__|~~/g;
/** 단어 경계에 붙은 한 글자 강조(`*x*`, `_x_`)만 — `user_id`·`a*b`는 그대로 둔다. */
const SINGLE_EMPHASIS = /(^|[^\p{L}\p{N}_*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_*])/gu;
const SPACES = /\s+/g;
/** 코드 구간 자리표시(사용자 영역 문자). 입력에 원래 있던 같은 문자는 먼저 지운다. */
const SLOT_OPEN = '\u{E000}';
const SLOT_CLOSE = '\u{E001}';
const SLOT_CHARS = /[\u{E000}\u{E001}]/gu;
const SLOT = /\u{E000}(\d+)\u{E001}/gu;

/** 평문화 입력 상한(code point). 미리보기는 100자만 쓰므로 마크업 제거분 여유를 두고 먼저 잘라 이차 시간 입력을 막는다. */
const PREVIEW_INPUT_MAX = 2000;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** grapheme을 쪼개지 않고 code point 합이 `max` 이하인 최대 접두사. */
function graphemePrefix(text: string, max: number): string {
  let used = 0;
  let out = '';
  for (const { segment } of GRAPHEMES.segment(text)) {
    used += [...segment].length;
    if (used > max) break;
    out += segment;
  }
  return out;
}

/** 길이가 정확히 `len`인 백틱 묶음의 시작 위치(`from` 이후). 없으면 -1. */
function findTickRun(text: string, from: number, len: number): number {
  let at = text.indexOf('`', from);
  while (at !== -1) {
    let end = at;
    while (text[end] === '`') end += 1;
    if (end - at === len) return at;
    at = text.indexOf('`', end);
  }
  return -1;
}

/**
 * 인라인 코드(같은 길이 백틱 묶음 사이)를 `keep`으로 바꾼다. 정규식 역추적 대신 한 번씩 훑는 스캐너 —
 * 닫는 묶음이 없던 길이는 기억해 다시 찾지 않으므로 백틱만 수천 개인 입력도 선형에 가깝다(Codex r3).
 */
function maskInlineCode(text: string, keep: (content: string) => string): string {
  const unclosed = new Set<number>();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('`', i);
    if (open === -1) return out + text.slice(i);
    let end = open;
    while (text[end] === '`') end += 1;
    const len = end - open;
    const close = unclosed.has(len) ? -1 : findTickRun(text, end, len);
    if (close === -1) {
      unclosed.add(len);
      out += text.slice(i, end);
    } else {
      out += text.slice(i, open) + keep(text.slice(end, close));
      end = close + len;
    }
    i = end;
  }
  return out;
}

function stripMarkup(text: string): string {
  return text
    .replace(FENCE_LINE, '')
    .replace(HEADER, '')
    .replace(QUOTE, '')
    .replace(LIST, '')
    .replace(LINK_OR_IMAGE, '$1')
    .replace(BACKTICKS, '')
    .replace(DOUBLE_MARKS, '')
    .replace(SINGLE_EMPHASIS, '$1$3');
}

export function toPreviewText(body: string): string | null {
  const code: string[] = [];
  const keep = (content: string): string => `${SLOT_OPEN}${code.push(content) - 1}${SLOT_CLOSE}`;
  const fenced = Array.from(body).slice(0, PREVIEW_INPUT_MAX).join('').replace(SLOT_CHARS, '').replace(FENCE_BLOCK, (_m, _fence: string, content: string) => keep(content));
  const masked = maskInlineCode(fenced, keep);
  const plain = stripMarkup(masked)
    .replace(SLOT, (_m, i: string) => code[Number(i)] ?? '')
    .replace(SPACES, ' ')
    .trim();
  if (plain.length === 0) return null;
  return [...plain].length <= MESSAGE_PREVIEW_MAX ? plain : `${graphemePrefix(plain, MESSAGE_PREVIEW_MAX).trimEnd()}…`;
}
