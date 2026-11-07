import { useRef } from 'react';
import type { Message } from '../../data';
import { dayKey } from '../conversation';

/**
 * CMP-09 위치(UI_STATES §2-4): 본문 읽음 커서 다음 원문 = 첫 미읽음 원문의 seq.
 * 클라이언트 모델에 `last_read_seq`가 없어(data 계층은 이 레인 쓰기 경로 밖) 진입 시점 `unread_count`
 * (= 읽지 않은 top-level 원문 수, TRD §3)로 뒤에서 센다. 미읽음이 화면 목록보다 많으면 첫 미읽음이 목록 밖이라 그리지 않는다.
 */
export function firstUnreadSeq(roots: readonly Message[], unreadCount: number, selfId?: string): number | null {
  if (unreadCount <= 0) return null;
  // 서버 집계와 같은 대상만 센다: 자기 메시지·삭제 원문 제외(Codex r1 P2).
  const server = roots.filter(
    (m) => m.seq !== undefined && m.pending === undefined && m.deleted !== true && (selfId === undefined || m.authorId !== selfId),
  );
  if (unreadCount > server.length) return null;
  return server[server.length - unreadCount]?.seq ?? null;
}

interface Entry {
  readonly spaceId: string;
  /** 진입 시점 미읽음 수. catch-up 중 진입이면 null — 동기화가 끝난 스냅숏 값을 쓴다(Codex r1 P2). */
  readonly unread: number | null;
  frozen: boolean;
  seq: number | null;
}

/**
 * 진입 시점 값을 고정한다 — 맨 아래에서 읽음을 저장(markRead)해 `unreadCount`가 0이 돼도 구분선이 바로 사라지지 않게(§2-4).
 * 미읽음 수는 진입 때 고정하고, 위치(앵커 원문)는 이력 조회가 끝난(`historyReady`) 뒤 원문이 있는 첫 렌더에서 한 번 계산한다 —
 * 캐시에 최신 몇 개만 있을 때 고정하면 이력이 도착해도 구분선이 없다(Codex r2 P2). catch-up 중(`holding`)에도 미룬다.
 * 공간이 바뀌면 다시 진입으로 본다.
 */
export function useNewMessagesSeq(
  spaceId: string,
  unreadCount: number,
  roots: readonly Message[],
  holding: boolean,
  historyReady: boolean,
  selfId?: string,
): number | null {
  const entry = useRef<Entry | null>(null);
  if (entry.current?.spaceId !== spaceId) entry.current = { spaceId, unread: holding ? null : unreadCount, frozen: false, seq: null };
  const current = entry.current;
  if (!current.frozen && !holding && historyReady && roots.some((m) => m.seq !== undefined)) {
    current.seq = firstUnreadSeq(roots, current.unread ?? unreadCount, selfId);
    current.frozen = true;
  }
  return current.seq;
}

/** CMP-10 위치: 목록 첫 원문과, 앞 원문과 날짜(`dayKey`)가 다른 원문 앞. */
export function startsNewDay(roots: readonly Message[], index: number): boolean {
  const current = roots[index];
  if (current === undefined) return false;
  const prev = roots[index - 1];
  return prev === undefined || dayKey(new Date(prev.createdAt)) !== dayKey(new Date(current.createdAt));
}
