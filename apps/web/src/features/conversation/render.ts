/**
 * 메시지 본문 → 표시용 블록(TRD §5, 디자인 §6-2 CMP-08). 순수 함수, HTML을 만들지 않는다.
 * 줄바꿈·코드 fence는 inert 텍스트로, 자동 링크는 `http`·`https`만 허용하고 그 외 스킴은 일반 텍스트로 둔다.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type Line = readonly Inline[];

export type Block =
  | { readonly kind: 'paragraph'; readonly lines: readonly Line[] }
  | { readonly kind: 'code'; readonly text: string };

/**
 * 파서는 입력 길이에 선형이어야 한다(SECURITY_REVIEW_P1 F-1: 서버 상한 4000자 본문으로 메인 스레드 DoS).
 * 그래서 백트래킹하는 후보 정규식과 문자마다 다시 세는 괄호 판정을 쓰지 않고, 토큰을 한 번씩만 훑는다.
 */
const FENCE = /^\s*```/;
/** 링크 후보가 들어갈 수 있는 토큰: 공백·`<>"'\``가 아닌 문자의 최대 연속 구간. 단순 문자 클래스라 백트래킹이 없다. */
const TOKEN = /[^\s<>"'`]+/g;
const TRAILING_PUNCT = new Set([...'.,;:!?\'"」』>']);
const CLOSE_TO_OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const BRACKETS = new Set([...'()[]{}']);

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** 스킴 문자 `[A-Za-z0-9+.-]`. */
function isSchemeChar(code: number): boolean {
  return isLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/**
 * 토큰 안 링크 후보 시작 위치(없으면 -1). 후보 = `[A-Za-z][A-Za-z0-9+.-]*:` 뒤에 한 글자 이상.
 * 가장 왼쪽 후보는 `:` 바로 앞 스킴 문자 연속 구간의 첫 영문자에서 시작하고 토큰 끝까지 이어진다.
 */
function linkStart(token: string): number {
  let runLetter = -1;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code === 0x3a) {
      if (runLetter !== -1 && i + 1 < token.length) return runLetter;
      runLetter = -1;
    } else if (!isSchemeChar(code)) {
      runLetter = -1;
    } else if (runLetter === -1 && isLetter(code)) {
      runLetter = i;
    }
  }
  return -1;
}

/** 링크 뒤 문장부호를 떼되, URL 안에서 짝이 맞는 닫는 괄호는 보존한다(`.../Function_(mathematics)`). O(n). */
export function trimTrailing(raw: string): string {
  const counts = new Map<string, number>();
  for (const ch of raw) if (BRACKETS.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let end = raw.length;
  for (;;) {
    const last = raw[end - 1] ?? '';
    const open = CLOSE_TO_OPEN[last];
    const unmatched = open !== undefined && (counts.get(last) ?? 0) > (counts.get(open) ?? 0);
    if (!TRAILING_PUNCT.has(last) && !unmatched) return raw.slice(0, end);
    if (BRACKETS.has(last)) counts.set(last, (counts.get(last) ?? 0) - 1);
    end -= 1;
  }
}
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** 허용 스킴(http/https)과 host가 있는 절대 URL이면 정규화된 href, 아니면 undefined. */
export function safeLinkHref(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.hostname === '') return undefined;
  return url.href;
}

export function linkify(text: string): Line {
  const out: Inline[] = [];
  let last = 0;
  for (const token of text.matchAll(TOKEN)) {
    const offset = linkStart(token[0]);
    if (offset === -1) continue;
    const raw = trimTrailing(token[0].slice(offset));
    const href = raw === '' ? undefined : safeLinkHref(raw);
    if (href === undefined) continue;
    const start = token.index + offset;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function paragraph(lines: readonly string[]): Block {
  return { kind: 'paragraph', lines: lines.map(linkify) };
}

/** 각 줄 기준 다음 fence 줄 인덱스(없으면 -1). 뒤에서 한 번 훑어 O(줄 수). */
function nextFenceIndex(lines: readonly string[]): readonly number[] {
  const next = new Array<number>(lines.length).fill(-1);
  let after = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    next[i] = after;
    if (FENCE.test(lines[i] ?? '')) after = i;
  }
  return next;
}

/** 본문을 문단·코드 블록으로 나눈다. 닫히지 않은 fence는 일반 텍스트로 둔다. */
export function parseBody(body: string): readonly Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const next = nextFenceIndex(lines);
  const blocks: Block[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const close = FENCE.test(line) ? (next[i] ?? -1) : -1;
    if (close === -1) {
      text.push(line);
      i += 1;
      continue;
    }
    if (text.length > 0) blocks.push(paragraph(text));
    text = [];
    blocks.push({ kind: 'code', text: lines.slice(i + 1, close).join('\n') });
    i = close + 1;
  }
  if (text.length > 0) blocks.push(paragraph(text));
  return blocks;
}
