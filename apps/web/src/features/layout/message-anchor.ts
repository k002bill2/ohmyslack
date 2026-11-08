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
/** 스레드 답글 조회가 끝나지 않을 때(실패·지연) 포기까지 기다리는 상한(ms) — Codex r1 P2. */
export const ANCHOR_REPLIES_TIMEOUT_MS = 10_000;

/**
 * 이번 재실행에서 기다릴 시간. 상한은 앵커별로 처음 기다리기 시작한 시각에 고정한다 — 실시간 메시지가 계속 와서
 * effect가 다시 돌아도 상한이 밀리지 않게(Codex 확인 라운드 P2). 유예(1.5초)는 렌더마다 다시 세되 상한을 넘지 않는다.
 */
function waitDelay(startedAt: number, waitReplies: boolean): number {
  const left = Math.max(0, startedAt + ANCHOR_REPLIES_TIMEOUT_MS - Date.now());
  return waitReplies ? left : Math.min(ANCHOR_GRACE_MS, left);
}

/** 보일 안내 — 스레드 대상이면 스레드 패널에, 아니면 대화 화면에 그린다(compact는 한 화면만 보임, Codex r1 P2). */
export interface AnchorNotice {
  readonly text: string;
  readonly inThread: boolean;
}

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
  /** 열린 스레드의 기존 답글 조회가 끝났는가(스레드 대상은 이것까지 기다린 뒤 부재를 판정). */
  readonly repliesReady: boolean;
  readonly threadOpen: boolean;
}

/** 강조 타이머·안내 상태. 반환값은 보일 안내 문구(없으면 null). */
function useAnchorFeedback() {
  const [notice, setNotice] = useState<AnchorNotice | null>(null);
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
  const missing = (scope: HTMLElement | null, inThread: boolean) => {
    if (scope !== null) scope.scrollTop = scope.scrollHeight;
    setNotice({ text: MESSAGE_ANCHOR_COPY.notFound, inThread });
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ANCHOR_NOTICE_MS);
  };
  return { notice, reveal, missing };
}

/** 알림 탭 대상 메시지로 스크롤·강조. 못 찾으면 맨 아래 + 짧은 안내(이전 이력 불러오기 API가 없어 대체 동작). */
export function useMessageAnchor({
  history,
  shell,
  conversationId,
  messages,
  historyReady,
  repliesReady,
  threadOpen,
}: MessageAnchorInput): AnchorNotice | null {
  const [anchor, setAnchor] = useState<Anchor | null>(() => readAnchor(history));
  const { notice, reveal, missing } = useAnchorFeedback();
  const waitStart = useRef<{ readonly anchor: Anchor; readonly at: number } | null>(null);

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
    if (waitStart.current?.anchor !== anchor) waitStart.current = { anchor, at: Date.now() };
    const timer = setTimeout(
      () => {
        missing(scopeOf(shell.current, anchor), anchor.inThread);
        finish();
      },
      waitDelay(waitStart.current.at, anchor.inThread && !repliesReady),
    );
    return () => clearTimeout(timer);
    // reveal·missing은 매 렌더 새 함수지만 ref·setState만 쓴다 — 데이터 변화에만 다시 찾는다.
  }, [anchor, conversationId, messages, historyReady, repliesReady, threadOpen, history, shell]);

  return notice;
}
