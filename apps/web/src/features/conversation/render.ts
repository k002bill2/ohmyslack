/**
 * 메시지 본문 → 표시용 블록(TRD §5, 디자인 §6-2 CMP-08). 순수 함수, HTML을 만들지 않는다.
 * 줄바꿈·코드 fence는 inert 텍스트로, 제한된 서식(FR-MSG-10)은 Inline/Block 구조로만 표현하고, 자동 링크는 `http`·`https`만 허용하고 그 외 스킴은 일반 텍스트로 둔다.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  /** 자동 링크는 text만, 마크다운 링크(FR-MSG-10)는 보이는 글자 children(텍스트·굵게)도 갖는다. */
  | { readonly kind: 'link'; readonly text: string; readonly href: string; readonly children?: readonly Inline[] }
  | { readonly kind: 'mention'; readonly text: string }
  /** 인라인 코드(FR-MSG-10). 안은 멘션·링크·서식 해석 0. */
  | { readonly kind: 'code'; readonly text: string }
  /** 굵게(FR-MSG-10). 안에는 인라인 코드·자동 링크·멘션까지만. */
  | { readonly kind: 'strong'; readonly children: readonly Inline[] };

export type Line = readonly Inline[];

export type HeadingLevel = 1 | 2 | 3;

export type Block =
  | { readonly kind: 'paragraph'; readonly lines: readonly Line[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly line: Line }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly Line[] };

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

/** 자동 링크 결과는 text·link뿐이다(이어 붙이면 입력과 같다). */
export type PlainInline = Extract<Inline, { readonly kind: 'text' | 'link' }>;

export function linkify(text: string): readonly PlainInline[] {
  const out: PlainInline[] = [];
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

/**
 * 제한된 서식(FR-MSG-10, ADR-001 §3-f — CommonMark 일반 관념의 부분 집합).
 * F-1(선형): 닫는 기호는 `Finder`로 찾는다. Finder는 마지막 결과를 기억하고 질의 위치가 앞으로만 가므로
 * 같은 구간을 두 번 훑지 않는다(기호별 O(n)). 정규식은 줄 앞 고정(`^`) 블록 표지에만 쓰고 백트래킹 후보가 없다.
 */
type Finder = (from: number) => number;

/** `needle`의 `from` 이후 첫 위치(-1). 결과 위치를 지나기 전까지는 다시 찾지 않는다. */
function stringFinder(text: string, needle: string): Finder {
  let from0 = Number.POSITIVE_INFINITY;
  let pos = -1;
  return (from) => {
    if (from >= from0 && (pos === -1 || from <= pos)) return pos;
    from0 = from;
    pos = text.indexOf(needle, from);
    return pos;
  };
}

/** 마크다운 링크 URL에 올 수 없는 문자(공백·괄호·대괄호·`<>"\``)의 `from` 이후 첫 위치. stringFinder와 같은 기억 규칙. */
function badUrlCharFinder(text: string): Finder {
  let from0 = Number.POSITIVE_INFINITY;
  let pos = -1;
  return (from) => {
    if (from >= from0 && (pos === -1 || from <= pos)) return pos;
    from0 = from;
    pos = -1;
    for (let i = from; i < text.length; i += 1) {
      if (BAD_URL_CHAR.has(text.charAt(i)) || SPACE.test(text.charAt(i))) {
        pos = i;
        break;
      }
    }
    return pos;
  };
}

const BAD_URL_CHAR: ReadonlySet<string> = new Set([...'()[]<>"`']);

/**
 * 굵게 닫는 `**` 찾기(Codex r1·r2·r3 P2). 줄 본문에서 연 굵게 안에서는 링크를 해석하지 않으므로 백틱은 굵게 시작 뒤부터 둘씩 짝지어진다.
 * 그래서 후보 `**`가 인라인 코드 밖인지는 「시작~후보 사이 백틱 수가 짝수」 또는 「후보 뒤에 백틱이 없어 짝이 안 닫힘」으로 정해지고,
 * 이는 줄 앞부터 센 백틱 수의 홀짝 2종으로 나뉜다. 홀짝별 Finder를 미리 두어 시작 위치마다 다시 훑지 않는다(O(n)).
 * 링크 글자 안 백틱은 코드 구분자가 아니므로(label 모드) 마스크 없이 찾는다.
 */
interface StrongClose {
  readonly byParity: readonly [Finder, Finder];
  readonly plain: Finder;
  /** 위치 앞 백틱 수의 홀짝(0·1). */
  readonly parity: (at: number) => 0 | 1;
}

function strongCloseFinders(line: string): StrongClose {
  const ticks = new Uint32Array(line.length + 1);
  for (let i = 0; i < line.length; i += 1) ticks[i + 1] = (ticks[i] ?? 0) + (line.charCodeAt(i) === 0x60 ? 1 : 0);
  const lastTick = line.lastIndexOf('`');
  const parity = (at: number): 0 | 1 => ((ticks[at] ?? 0) & 1) as 0 | 1;
  const finder = (p: 0 | 1): Finder => {
    let from0 = Number.POSITIVE_INFINITY;
    let pos = -1;
    return (from) => {
      if (from >= from0 && (pos === -1 || from <= pos)) return pos;
      from0 = from;
      pos = -1;
      for (let i = line.indexOf('**', from); i !== -1; i = line.indexOf('**', i + 1)) {
        if (i > lastTick || parity(i) === p) {
          pos = i;
          break;
        }
      }
      return pos;
    };
  };
  return { byParity: [finder(0), finder(1)], plain: stringFinder(line, '**'), parity };
}

/** 줄 전체 자동 링크의 시작 → 끝 위치(Codex r1 P2: URL 안 `**`·`[`는 서식이 아니라 URL 일부). linkify 출력을 이어 붙이면 입력과 같다. */
function autolinkSpans(line: string): ReadonlyMap<number, number> {
  const spans = new Map<number, number>();
  let offset = 0;
  for (const part of linkify(line)) {
    if (part.kind === 'link') spans.set(offset, offset + part.text.length);
    offset += part.text.length;
  }
  return spans;
}

interface Scan {
  readonly line: string;
  readonly index: MentionIndex;
  readonly stars: StrongClose;
  readonly tick: Finder;
  readonly open: Finder;
  readonly close: Finder;
  readonly paren: Finder;
  readonly bad: Finder;
  readonly autolinks: ReadonlyMap<number, number>;
}

/** top: 줄 본문, strong: 굵게 안(인라인 코드만), label: 링크 글자 안(굵게만, 멘션·링크 미적용). */
type Mode = 'top' | 'strong' | 'label';

interface Hit {
  /** undefined면 서식이 아니라 원문으로 남기고 end까지 건너뛴다(빈 인라인 코드 ``). */
  readonly node?: Inline;
  readonly end: number;
}

function createScan(line: string, index: MentionIndex): Scan {
  return {
    line,
    index,
    stars: strongCloseFinders(line),
    tick: stringFinder(line, '`'),
    open: stringFinder(line, '['),
    close: stringFinder(line, ']'),
    paren: stringFinder(line, ')'),
    bad: badUrlCharFinder(line),
    autolinks: autolinkSpans(line),
  };
}

/** 서식 밖 원문: 자동 링크 + 멘션. lineStart는 이 구간 앞이 경계(줄 시작·굵게 시작)인지. */
function plainInlines(text: string, lineStart: boolean, index: MentionIndex): readonly Inline[] {
  const parts = linkify(text);
  if (index.size === 0) return parts;
  return parts.flatMap((part, i) => (part.kind === 'text' ? splitMentions(part.text, lineStart && i === 0, index) : [part]));
}

function codeAt(s: Scan, i: number, to: number): Hit | undefined {
  const close = s.tick(i + 1);
  if (close === -1 || close >= to) return undefined;
  if (close === i + 1) return { end: i + 2 };
  return { node: { kind: 'code', text: s.line.slice(i + 1, close) }, end: close + 1 };
}

/** `**x**`: 첫 닫는 `**`까지, 안쪽 첫·끝 글자가 공백이면 서식 아님(CommonMark flanking 관념의 단순화). */
function strongAt(s: Scan, i: number, to: number, mode: Mode): Hit | undefined {
  const find = mode === 'label' ? s.stars.plain : s.stars.byParity[s.stars.parity(i + 2)];
  const close = find(i + 2);
  if (close === -1 || close + 2 > to || close === i + 2) return undefined;
  if (SPACE.test(s.line.charAt(i + 2)) || SPACE.test(s.line.charAt(close - 1))) return undefined;
  const children: readonly Inline[] =
    mode === 'label' ? [{ kind: 'text', text: s.line.slice(i + 2, close) }] : parseRange(s, i + 2, close, 'strong');
  return { node: { kind: 'strong', children }, end: close + 2 };
}

/** `[글자](http(s)://…)`: 글자 안 `[` 없음, URL은 첫 `)`까지이고 공백·괄호 없음, 스킴은 safeLinkHref. */
function linkAt(s: Scan, i: number, to: number): Hit | undefined {
  const close = s.close(i + 1);
  if (close === -1 || close + 1 >= to || close === i + 1 || s.line.charAt(close + 1) !== '(') return undefined;
  const nested = s.open(i + 1);
  if (nested !== -1 && nested < close) return undefined;
  const paren = s.paren(close + 2);
  if (paren === -1 || paren >= to || paren === close + 2) return undefined;
  const bad = s.bad(close + 2);
  if (bad !== -1 && bad < paren) return undefined;
  const href = safeLinkHref(s.line.slice(close + 2, paren));
  if (href === undefined) return undefined;
  const children = parseRange(s, i + 1, close, 'label');
  return { node: { kind: 'link', text: visibleText(children), href, children }, end: paren + 1 };
}

function visibleText(parts: readonly Inline[]): string {
  return parts.map((part) => (part.kind === 'strong' ? visibleText(part.children) : part.text)).join('');
}

function formatAt(s: Scan, i: number, to: number, mode: Mode): Hit | undefined {
  const ch = s.line.charAt(i);
  if (ch === '`' && mode !== 'label') return codeAt(s, i, to);
  if (ch === '*' && mode !== 'strong' && s.line.charAt(i + 1) === '*') return strongAt(s, i, to, mode);
  if (ch === '[' && mode === 'top') return linkAt(s, i, to);
  return undefined;
}

/** [from, to) 구간을 서식·원문 인라인으로. 실패한 기호는 원문 구간에 그대로 남아 텍스트 노드가 쪼개지지 않는다. */
function parseRange(s: Scan, from: number, to: number, mode: Mode): readonly Inline[] {
  const out: Inline[] = [];
  const flush = (a: number, b: number) => {
    if (b <= a) return;
    const text = s.line.slice(a, b);
    if (mode === 'label') out.push({ kind: 'text', text });
    else out.push(...plainInlines(text, a === from, s.index));
  };
  let pending = from;
  let i = from;
  while (i < to) {
    const autolinkEnd = mode === 'label' ? undefined : s.autolinks.get(i);
    if (autolinkEnd !== undefined) {
      i = autolinkEnd;
      continue;
    }
    const hit = formatAt(s, i, to, mode);
    if (hit === undefined) {
      i += 1;
      continue;
    }
    if (hit.node !== undefined) {
      flush(pending, i);
      out.push(hit.node);
      pending = hit.end;
    }
    i = hit.end;
  }
  flush(pending, to);
  return out;
}

function inlineLine(line: string, index: MentionIndex): Line {
  return parseRange(createScan(line, index), 0, line.length, 'top');
}

/** 블록 표지(줄 앞 고정, 들여쓰기 없음). `+`는 \S 앞에서만 끝나므로 되돌아감이 줄 길이에 선형이다. */
const HEADING = /^(#{1,3}) +(\S.*)$/;
const BULLET = /^[-*] +(\S.*)$/;
const ORDERED = /^(\d{1,9})\. +(\S.*)$/;

type LineMark =
  | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly content: string }
  | { readonly kind: 'item'; readonly ordered: boolean; readonly num: number; readonly content: string };

function classify(line: string): LineMark | undefined {
  const h = HEADING.exec(line);
  if (h !== null) return { kind: 'heading', level: (h[1] ?? '#').length as HeadingLevel, content: h[2] ?? '' };
  const b = BULLET.exec(line);
  if (b !== null) return { kind: 'item', ordered: false, num: 1, content: b[1] ?? '' };
  const o = ORDERED.exec(line);
  if (o !== null) return { kind: 'item', ordered: true, num: Number(o[1]), content: o[2] ?? '' };
  return undefined;
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

/** 본문을 문단·코드·제목·목록 블록으로 나눈다. 닫히지 않은 fence는 일반 텍스트로 둔다. mentionNames가 있으면 원문 구간의 `@이름`을 mention으로 나눈다. */
export function parseBody(body: string, mentionNames?: readonly string[]): readonly Block[] {
  const index = mentionIndex(mentionNames ?? []);
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const next = nextFenceIndex(lines);
  const acc = createAccumulator(index);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const close = FENCE.test(line) ? (next[i] ?? -1) : -1;
    if (close === -1) {
      acc.line(line);
      i += 1;
      continue;
    }
    acc.code(lines.slice(i + 1, close).join('\n'));
    i = close + 1;
  }
  return acc.done();
}

/**
 * 줄을 블록으로 모은다. 서식 없는 본문은 수정 전과 같은 문단(빈 줄 포함)을 만든다.
 * 제목·목록 바로 앞뒤 빈 줄은 블록 간격이 대신하므로 버린다(목록 사이 빈 줄은 목록을 끊지 않는다).
 */
function createAccumulator(index: MentionIndex) {
  const blocks: Block[] = [];
  let text: string[] = [];
  let list: { ordered: boolean; start: number; items: Line[] } | undefined;
  let afterFormat = false;
  const flushText = (trimTail: boolean) => {
    let end = text.length;
    while (trimTail && end > 0 && (text[end - 1] ?? '').trim() === '') end -= 1;
    if (end > 0) blocks.push({ kind: 'paragraph', lines: text.slice(0, end).map((l) => inlineLine(l, index)) });
    text = [];
  };
  const flushList = () => {
    if (list !== undefined) blocks.push({ kind: 'list', ordered: list.ordered, start: list.start, items: list.items });
    list = undefined;
  };
  const addMark = (mark: LineMark) => {
    flushText(true);
    afterFormat = true;
    if (mark.kind === 'heading') {
      flushList();
      blocks.push({ kind: 'heading', level: mark.level, line: inlineLine(mark.content, index) });
      return;
    }
    if (list !== undefined && list.ordered !== mark.ordered) flushList();
    list ??= { ordered: mark.ordered, start: mark.num, items: [] };
    list.items.push(inlineLine(mark.content, index));
  };
  return {
    line(raw: string) {
      const mark = classify(raw);
      if (mark !== undefined) return addMark(mark);
      if (afterFormat && raw.trim() === '') return;
      flushList();
      afterFormat = false;
      text.push(raw);
    },
    code(body: string) {
      flushList();
      flushText(false);
      afterFormat = false;
      blocks.push({ kind: 'code', text: body });
    },
    done(): readonly Block[] {
      flushList();
      flushText(false);
      return blocks;
    },
  };
}

/**
 * `@이름` 멘션 토큰(디자인 01/05). 클라이언트 Message에는 mention_user_ids가 없어 알려진 멤버 표시 이름으로만 맞춘다.
 * 경계: `@` 앞은 줄(인라인) 시작 또는 공백, 이름 뒤는 끝·공백·문장부호(문자·숫자·`_`가 아님). 대소문자 구분 정확 일치, 가장 긴 이름 우선.
 * 그래서 `@홍길동님`은 뒤가 글자라 멘션이 아니다(조사 붙은 경우를 놓치는 쪽을 택해 `@김철`/`@김철수` 오인을 막는다).
 * F-1: `@` 위치만 indexOf로 훑고 첫 글자별 후보(길이 내림차순)만 검사하므로 본문 길이에 선형이다.
 */
type MentionIndex = ReadonlyMap<string, readonly string[]>;

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;

function mentionIndex(names: readonly string[]): MentionIndex {
  const sorted = [...new Set(names)].filter((name) => name !== '').sort((a, b) => b.length - a.length);
  const index = new Map<string, string[]>();
  for (const name of sorted) {
    const key = name.charAt(0);
    index.set(key, [...(index.get(key) ?? []), name]);
  }
  return index;
}

function matchAt(text: string, at: number, index: MentionIndex): string | undefined {
  const start = at + 1;
  for (const name of index.get(text.charAt(start)) ?? []) {
    if (!text.startsWith(name, start)) continue;
    const next = text.codePointAt(start + name.length);
    if (next === undefined || !WORD_CHAR.test(String.fromCodePoint(next))) return name;
  }
  return undefined;
}

/** text 하나를 text/mention 인라인으로 나눈다. lineStart는 이 text가 줄의 첫 인라인인지(링크 바로 뒤 `@`는 경계가 아니다). */
function splitMentions(text: string, lineStart: boolean, index: MentionIndex): readonly Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    const bounded = at === 0 ? lineStart : SPACE.test(text.charAt(at - 1));
    const name = bounded ? matchAt(text, at, index) : undefined;
    if (name === undefined) {
      at = text.indexOf('@', at + 1);
      continue;
    }
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'mention', text: `@${name}` });
    last = at + 1 + name.length;
    at = text.indexOf('@', last);
  }
  if (last === 0) return [{ kind: 'text', text }];
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** 블록의 모든 인라인 줄(문단 줄·제목·목록 항목). 코드 블록은 없다. */
function blockLines(block: Block): readonly Line[] {
  if (block.kind === 'paragraph') return block.lines;
  if (block.kind === 'heading') return [block.line];
  if (block.kind === 'list') return block.items;
  return [];
}

/** 멘션은 원문 구간과 굵게 안에만 생긴다(인라인 코드·링크 글자 안은 원문). */
function lineHasMention(line: Line, target: string): boolean {
  return line.some((part) =>
    part.kind === 'mention' ? part.text === target : part.kind === 'strong' && lineHasMention(part.children, target),
  );
}

/** 본문이 `@name`을 멘션하는지(parseBody와 같은 경계 규칙, 코드 블록·인라인 코드·링크 안은 제외). "나를 멘션" 계산용. */
export function bodyMentionsName(body: string, name: string, allNames: readonly string[] = []): boolean {
  const target = `@${name}`;
  // 본문 렌더와 같은 후보 전체로 토큰화 — `@Ann Smith`를 `@Ann`으로 오판하지 않게(최장 일치, Codex r3 P2).
  const names = allNames.includes(name) ? allNames : [...allNames, name];
  return parseBody(body, names).some((block) => blockLines(block).some((line) => lineHasMention(line, target)));
}
