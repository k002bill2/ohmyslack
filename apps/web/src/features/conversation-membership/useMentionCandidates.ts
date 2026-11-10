import { useEffect, useState } from 'react';
import type { DataSource } from '../../data';
import type { MentionCandidate } from '../conversation';

/**
 * CMP-12 후보원: 현재 대화 참여자(`GET /api/conversations/{id}/members`). 대화나 `revision`이 바뀌면 다시 읽는다.
 * 구현이 없으면 undefined(작성기는 멘션 없이 동작). 실패는 빈 후보 — 정본에 로딩·오류 문구가 없다(UI_STATES §2-6, REPORT).
 */
export function useMentionCandidates(
  dataSource: DataSource,
  conversationId: string | null,
  enabled: boolean,
  /** 바뀌면 같은 대화라도 다시 읽는다(봇 추가·제거 뒤, FR-BOT-11). 다시 읽는 동안은 이전 목록을 유지한다. */
  revision = 0,
): readonly MentionCandidate[] | undefined {
  return useConversationMembers(dataSource, conversationId, enabled, revision).candidates;
}

export interface ConversationMembers {
  /** `useMentionCandidates`와 같은 값(실패는 빈 후보). */
  readonly candidates: readonly MentionCandidate[] | undefined;
  /** 이 대화의 멤버 목록을 2xx로 확인했는가. 로딩 전·실패면 false — 멤버십 판정(봇 추가·제거)은 true일 때만 한다(Codex L3 P2). */
  readonly confirmed: boolean;
}

/** 멘션 후보원 + 조회 성공 여부. 실패를 「멤버 아님」으로 읽지 않게 성공 여부를 따로 돌려준다. */
export function useConversationMembers(dataSource: DataSource, conversationId: string | null, enabled: boolean, revision = 0): ConversationMembers {
  const supported = dataSource.listConversationMembers !== undefined;
  const [state, setState] = useState<{ readonly id: string; readonly list: readonly MentionCandidate[]; readonly ok: boolean } | null>(null);
  useEffect(() => {
    if (!supported || !enabled || conversationId === null) return undefined;
    let live = true;
    void dataSource.listConversationMembers?.(conversationId).then((res) => {
      if (live) setState({ id: conversationId, list: res.ok ? res.value : [], ok: res.ok });
    });
    return () => {
      live = false;
    };
  }, [dataSource, conversationId, supported, enabled, revision]);
  if (!supported) return { candidates: undefined, confirmed: false };
  const mine = state?.id === conversationId ? state : null;
  return { candidates: mine?.list ?? [], confirmed: mine?.ok === true };
}
