import { MESSAGE_PREVIEW_MAX } from '../../shared.js';

/**
 * 알림 미리보기 평문화(TRD §6-2, FR-CLIENT-05). 순수 함수.
 * 마크다운 표식(코드 펜스·인라인 코드·강조·링크·헤더·인용·목록 기호)을 걷어 내고 공백을 1칸으로 접은 뒤
 * 최대 `MESSAGE_PREVIEW_MAX` code point로 자른다(초과 시 `…`). 평문이 비면 null.
 */
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

export function toPreviewText(body: string): string | null {
  const plain = body
    .replace(FENCE_LINE, '')
    .replace(HEADER, '')
    .replace(QUOTE, '')
    .replace(LIST, '')
    .replace(LINK_OR_IMAGE, '$1')
    .replace(BACKTICKS, '')
    .replace(DOUBLE_MARKS, '')
    .replace(SINGLE_EMPHASIS, '$1$3')
    .replace(SPACES, ' ')
    .trim();
  if (plain.length === 0) return null;
  const points = [...plain];
  return points.length <= MESSAGE_PREVIEW_MAX ? plain : `${points.slice(0, MESSAGE_PREVIEW_MAX).join('').trimEnd()}…`;
}
