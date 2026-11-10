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
  const supported = dataSource.listConversationMembers !== undefined;
  const [state, setState] = useState<{ readonly id: string; readonly list: readonly MentionCandidate[] } | null>(null);
  useEffect(() => {
    if (!supported || !enabled || conversationId === null) return undefined;
    let live = true;
    void dataSource.listConversationMembers?.(conversationId).then((res) => {
      if (live) setState({ id: conversationId, list: res.ok ? res.value : [] });
    });
    return () => {
      live = false;
    };
  }, [dataSource, conversationId, supported, enabled, revision]);
  if (!supported) return undefined;
  return state?.id === conversationId ? state.list : [];
}
