import type { Attachment415Code } from '../../shared.js';

/**
 * 문서 판정기 공통 실패·예산(정본: TRD §6-1-1 (2)). 목록 판정기(zip-list·ole-list)는 컨테이너 서명이 맞는데 규칙을 어기면
 * DocSniffError를 던진다(→ 415). `reason`은 ops 로그 허용 값(본문·파일명 미포함)이다.
 */
export type DocSniffCode = Extract<Attachment415Code, 'unsupported_media_type' | 'encrypted_document'>;

export class DocSniffError extends Error {
  constructor(
    readonly code: DocSniffCode,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'DocSniffError';
  }
}

/** 벽시계 보조 상한(1차 통제는 단계 상한). 테스트는 가짜 `now`를 주입한다. */
export interface SniffBudget {
  readonly now: () => number;
  readonly deadline: number;
}

export function checkDeadline(budget: SniffBudget): void {
  if (budget.now() > budget.deadline) throw new DocSniffError('unsupported_media_type', 'sniff_deadline');
}

export const reject = (reason: string): DocSniffError => new DocSniffError('unsupported_media_type', reason);
