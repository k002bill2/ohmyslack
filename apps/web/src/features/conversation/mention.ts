/**
 * CMP-12 MentionPicker 순수 함수(UI_STATES §2-6, D §6-2). 후보원은 `GET /api/conversations/{id}/members`.
 * 후보 수 상한: 정본 수치가 없어(REPORT 기록) 서버 `mention_user_ids` 상한(T §5 `MENTION_IDS_MAX`)과 같은 100으로 자른다.
 */

export interface MentionCandidate {
  readonly id: string;
  readonly displayName: string;
}

export interface MentionSelection {
  readonly id: string;
  readonly displayName: string;
}

/** 표시 후보 상한(서버 `MENTION_IDS_MAX`와 같은 값). */
export const MENTION_CANDIDATE_LIMIT = 100;

export interface MentionQuery {
  /** `@` 위치. */
  readonly start: number;
  /** `@` 뒤부터 커서까지(공백 없음). */
  readonly query: string;
}

/** 커서 앞의 `@트리거`. `@`는 줄 처음이거나 공백 뒤여야 하고, 커서까지 공백이 없어야 한다. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/u.test(query)) return null;
  if (at > 0 && !/\s/u.test(before.charAt(at - 1))) return null;
  return { start: at, query };
}

/** 자기 자신 제외 + 이름 부분 일치(대소문자 무시) + 상한. */
export function filterCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  selfId: string | undefined,
): readonly MentionCandidate[] {
  const q = query.toLocaleLowerCase();
  return candidates
    .filter((c) => c.id !== selfId && c.displayName.toLocaleLowerCase().includes(q))
    .slice(0, MENTION_CANDIDATE_LIMIT);
}

/** `@query`를 `@이름 `으로 바꾼 본문과 새 커서 위치. */
export function insertMention(text: string, q: MentionQuery, name: string): { readonly text: string; readonly caret: number } {
  const head = `${text.slice(0, q.start)}@${name} `;
  return { text: head + text.slice(q.start + 1 + q.query.length), caret: head.length };
}

/** `@이름` 뒤가 공백·끝인 출현 횟수(`@Bob`이 `@Bobby`에 걸리지 않게). */
function countMentions(text: string, name: string): number {
  let count = 0;
  for (let i = text.indexOf(`@${name}`); i >= 0; i = text.indexOf(`@${name}`, i + 1)) {
    const after = text.charAt(i + name.length + 1);
    if (after === '' || /\s/u.test(after)) count += 1;
  }
  return count;
}

/**
 * 본문에 남은 멘션만 ID로. 같은 이름의 선택이 여럿이면 본문 출현 횟수만큼만(나중 선택 우선) 남긴다(Codex r1 P2). 중복 ID 제거·상한.
 */
export function mentionIdsIn(text: string, selected: readonly MentionSelection[]): readonly string[] {
  const left = new Map<string, number>();
  const kept: string[] = [];
  for (const s of [...selected].reverse()) {
    const remaining = left.get(s.displayName) ?? countMentions(text, s.displayName);
    if (remaining <= 0) continue;
    left.set(s.displayName, remaining - 1);
    kept.push(s.id);
  }
  return [...new Set(kept.reverse())].slice(0, MENTION_CANDIDATE_LIMIT);
}

/** 초안과 함께 보존할 선택 목록 직렬화(DraftStore는 문자열만 담는다). */
export const MENTION_DRAFT_SUFFIX = '\u0000mentions';
export function parseSelections(raw: string | undefined): readonly MentionSelection[] {
  if (raw === undefined) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((v): v is MentionSelection => typeof v?.id === 'string' && typeof v?.displayName === 'string')
      : [];
  } catch {
    return [];
  }
}
