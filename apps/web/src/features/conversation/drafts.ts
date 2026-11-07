/**
 * 작성기 초안 저장소(디자인 §7-3 "초안 규칙"). 대상(대화 id 또는 스레드 root id)별 **메모리 맵**만 쓴다 —
 * 지속 저장 없음(FR-CLIENT-04). 로그아웃·401에서는 소유자가 `clear()`로 전부 폐기한다.
 */
export interface DraftStore {
  /** 없으면 빈 문자열. */
  readonly get: (key: string) => string;
  /** 빈 문자열이면 항목을 지운다. */
  readonly set: (key: string, text: string) => void;
  readonly delete: (key: string) => void;
  readonly clear: () => void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, string>();
  return Object.freeze({
    get: (key: string) => drafts.get(key) ?? '',
    set: (key: string, text: string) => {
      if (text === '') drafts.delete(key);
      else drafts.set(key, text);
    },
    delete: (key: string) => {
      drafts.delete(key);
    },
    clear: () => drafts.clear(),
  });
}
