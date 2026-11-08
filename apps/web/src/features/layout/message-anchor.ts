import { useEffect, useRef, useState, type RefObject } from 'react';
import { parseRoute, parseThreadParam, withThread, type RouteHistory } from '../../app/route.js';
import type { Message } from '../../data';
import { MESSAGE_ANCHOR_COPY } from '../../ui/copy.js';

/**
 * 알림 탭 위치 복원(W-23 Codex P2-3, TRD §6-2 / UI_STATES §2-10): `/c/:id(?thread=:root)#message-:id`로 열리면
 * 이미 라우팅된 대화(또는 스레드 패널) 안에서만 그 메시지를 찾아 가운데로 스크롤·잠깐 강조한다.
 * 해시는 DOM 조회에만 쓴다 — 다른 대화로 이동하거나 주소를 해시로 만들지 않는다. 저장은 메모리뿐(B7).
 */

/** 강조 유지 시간(ms). */
export const ANCHOR_HIGHLIGHT_MS = 3000;
/** 「메시지를 찾을 수 없습니다」 안내 유지 시간(ms). */
export const ANCHOR_NOTICE_MS = 5000;
/** 이력·스레드 답글이 늦게 와도 기다리는 여유(ms). 렌더가 바뀔 때마다 다시 센다. */
export const ANCHOR_GRACE_MS = 1500;

/** 메시지 id는 UUID(서버 `uuid` 열, push payload `z.uuid()`와 같은 형식). */
const ANCHOR = /^#message-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** `#message-<uuid>` → id. 형식이 다르면 null(디코딩하지 않는다 — UUID는 인코딩이 필요 없다). */
export function parseMessageAnchor(hash: string): string | null {
  return ANCHOR.exec(hash)?.[1] ?? null;
}

interface Anchor {
  readonly messageId: string;
  /** 해시를 읽은 시점의 대화 — 다른 대화로 옮기면 버린다. */
  readonly conversationId: string;
  /** `?thread=`가 있으면 스레드 패널 안에서 찾는다. */
  readonly inThread: boolean;
}

function readAnchor(history: RouteHistory | undefined): Anchor | null {
  if (history?.hash === undefined) return null;
  const messageId = parseMessageAnchor(history.hash());
  const route = parseRoute(history.pathname());
  if (messageId === null || route.kind !== 'conversation') return null;
  return { messageId, conversationId: route.conversationId, inThread: parseThreadParam(history.search?.() ?? '') !== null };
}

/** 스크롤 컨테이너: 스레드 패널 또는 본문 메시지 목록. */
function scopeOf(shell: HTMLElement | null, anchor: Anchor): HTMLElement | null {
  return shell?.querySelector<HTMLElement>(anchor.inThread ? '.thread-panel' : '.conversation-pane .message-list') ?? null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 처리 끝: 뒤로·새로고침이 다시 일으키지 않게 해시만 뗀다(경로·`?thread=`는 유지). */
function stripHash(history: RouteHistory | undefined): void {
  if (history?.hash === undefined || history.hash() === '') return;
  history.replace(withThread(history.pathname(), parseThreadParam(history.search?.() ?? '')));
}

export interface MessageAnchorInput {
  readonly history: RouteHistory | undefined;
  readonly shell: RefObject<HTMLElement | null>;
  /** 현재 선택된 대화(셸 상태). */
  readonly conversationId: string | null;
  /** 스냅샷 메시지(바뀔 때마다 다시 찾는다). */
  readonly messages: readonly Message[];
  /** 현재 대화 이력 조회가 끝났는가. */
  readonly historyReady: boolean;
  readonly threadOpen: boolean;
}

/** 강조 타이머·안내 상태. 반환값은 보일 안내 문구(없으면 null). */
function useAnchorFeedback() {
  const [notice, setNotice] = useState<string | null>(null);
  const highlight = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHighlight = () => {
    if (highlight.current === null) return;
    clearTimeout(highlight.current.timer);
    highlight.current.el.removeAttribute('data-highlighted');
    highlight.current = null;
  };
  useEffect(
    () => () => {
      clearHighlight();
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );
  const reveal = (el: HTMLElement) => {
    clearHighlight();
    el.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    el.setAttribute('data-highlighted', 'true');
    highlight.current = { el, timer: setTimeout(clearHighlight, ANCHOR_HIGHLIGHT_MS) };
  };
  const missing = (scope: HTMLElement | null) => {
    if (scope !== null) scope.scrollTop = scope.scrollHeight;
    setNotice(MESSAGE_ANCHOR_COPY.notFound);
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ANCHOR_NOTICE_MS);
  };
  return { notice, reveal, missing };
}

/** 알림 탭 대상 메시지로 스크롤·강조. 못 찾으면 맨 아래 + 짧은 안내(이전 이력 불러오기 API가 없어 대체 동작). */
export function useMessageAnchor({ history, shell, conversationId, messages, historyReady, threadOpen }: MessageAnchorInput): string | null {
  const [anchor, setAnchor] = useState<Anchor | null>(() => readAnchor(history));
  const { notice, reveal, missing } = useAnchorFeedback();

  // SW `client.navigate`가 같은 문서의 해시만 바꾸면 `popstate`로 온다.
  useEffect(() => history?.listen(() => setAnchor(readAnchor(history))), [history]);

  useEffect(() => {
    if (anchor === null) return;
    if (anchor.conversationId !== conversationId) {
      setAnchor(null);
      return;
    }
    if (!historyReady) return;
    const finish = () => {
      setAnchor(null);
      stripHash(history);
    };
    const scope = scopeOf(shell.current, anchor);
    const target = scope?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.messageId)}"]`) ?? null;
    if (target !== null) {
      reveal(target);
      finish();
      return;
    }
    const timer = setTimeout(() => {
      missing(scopeOf(shell.current, anchor));
      finish();
    }, ANCHOR_GRACE_MS);
    return () => clearTimeout(timer);
    // reveal·missing은 매 렌더 새 함수지만 ref·setState만 쓴다 — 데이터 변화에만 다시 찾는다.
  },[anchor, conversationId, messages, historyReady, threadOpen, history, shell]);

  return notice;
}
