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

const FENCE = /^\s*```/;
/** 링크 후보: `스킴:` 으로 시작하는 공백 없는 토큰. 스킴 허용 여부는 `safeLinkHref`가 판정한다. */
const LINK_CANDIDATE = /[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'`]+/g;
const TRAILING_PUNCT = new Set([...'.,;:!?\'"」』>']);
const CLOSE_TO_OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** 링크 뒤 문장부호를 떼되, URL 안에서 짝이 맞는 닫는 괄호는 보존한다(`.../Function_(mathematics)`). */
export function trimTrailing(raw: string): string {
  let out = raw;
  for (;;) {
    const last = out.at(-1) ?? '';
    const open = CLOSE_TO_OPEN[last];
    const strip = TRAILING_PUNCT.has(last) || (open !== undefined && count(out, last) > count(out, open));
    if (!strip) return out;
    out = out.slice(0, -1);
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
  for (const match of text.matchAll(LINK_CANDIDATE)) {
    const raw = trimTrailing(match[0]);
    const href = raw === '' ? undefined : safeLinkHref(raw);
    if (href === undefined) continue;
    const start = match.index;
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

/** 본문을 문단·코드 블록으로 나눈다. 닫히지 않은 fence는 일반 텍스트로 둔다. */
export function parseBody(body: string): readonly Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const close = FENCE.test(line) ? lines.findIndex((l, j) => j > i && FENCE.test(l)) : -1;
    if (close === -1) {
      text = [...text, line];
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
