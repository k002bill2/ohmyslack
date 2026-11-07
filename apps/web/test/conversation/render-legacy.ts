/**
 * F-1 수정 전 `render.ts` 파서 사본(base 560f961). 새 선형 파서와의 동치 속성 테스트 전용 — 프로덕션 코드에서 import 금지.
 * O(n²) 구현을 그대로 둔다(동작 기준점).
 */
import { safeLinkHref, type Block, type Inline, type Line } from '../../src/features/conversation/render.js';

const FENCE = /^\s*```/;
/** 링크 후보: `스킴:` 으로 시작하는 공백 없는 토큰. 스킴 허용 여부는 `safeLinkHref`가 판정한다. */
const LINK_CANDIDATE = /[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'`]+/g;
const TRAILING_PUNCT = new Set([...'.,;:!?\'"」』>']);
const CLOSE_TO_OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** 링크 뒤 문장부호를 떼되, URL 안에서 짝이 맞는 닫는 괄호는 보존한다(`.../Function_(mathematics)`). */
function trimTrailing(raw: string): string {
  let out = raw;
  for (;;) {
    const last = out.at(-1) ?? '';
    const open = CLOSE_TO_OPEN[last];
    const strip = TRAILING_PUNCT.has(last) || (open !== undefined && count(out, last) > count(out, open));
    if (!strip) return out;
    out = out.slice(0, -1);
  }
}

export function legacyLinkify(text: string): Line {
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
  return { kind: 'paragraph', lines: lines.map(legacyLinkify) };
}

/** 본문을 문단·코드 블록으로 나눈다. 닫히지 않은 fence는 일반 텍스트로 둔다. */
export function legacyParseBody(body: string): readonly Block[] {
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
