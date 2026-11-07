import { useEffect, useRef, type KeyboardEvent } from 'react';
import { COMPOSER_COPY, THREAD_EMPTY_TEXT, THREAD_SUMMARY_COPY } from '../../ui/copy.js';
import { Composer, MessageItem, lastServerSeq, scrolledToBottom, type DraftStore, type MessageItemData, type MessageItemProps } from '../conversation';

export type ThreadVariant = 'wide' | 'medium' | 'compact';

export interface ThreadPanelProps {
  readonly variant: ThreadVariant;
  readonly root: MessageItemData;
  readonly replies: readonly MessageItemData[];
  readonly onClose: () => void;
  readonly onSend: (body: string) => void;
  /** StatusRegion(CMP-16) 안내. */
  readonly announce: (text: string) => void;
  /** 대상별 초안 저장소(디자인 §7-3 초안 규칙). 키는 스레드 root id. */
  readonly drafts?: DraftStore;
  /** 실패 답글 「다시 시도」·「삭제」(client_message_id). */
  readonly onRetry?: (clientMessageId: string) => void;
  readonly onDiscard?: (clientMessageId: string) => void;
  /** 본인 메시지 수정·삭제(W-10i). 원문·답글 모두 같은 규칙. */
  readonly messageActions?: Pick<MessageItemProps, 'selfId' | 'onEdit' | 'onDelete'>;
  /** FR-SYNC-03: 패널이 맨 아래(마지막 답글이 보임)일 때 그 답글 seq를 알린다. 답글이 없으면 부르지 않는다(본문 열기 ≠ 답글 읽음). */
  readonly onSeen?: (seq: number) => void;
  /** 헤더 보조 줄 「채널 · 답글 n」의 채널 이름(시안 01·06). 없으면 「답글 n」만. */
  readonly spaceTitle?: string;
}

/** 디자인 §7-3: wide 작성기에 입력이 있으면 1.5초 안에 Esc 2회로 닫는다. */
export const DOUBLE_ESC_WINDOW_MS = 1500;
export const DOUBLE_ESC_HINT = '닫으려면 Esc를 한 번 더 누르세요';

function variantProps(variant: ThreadVariant) {
  if (variant === 'medium') return { role: 'dialog', 'aria-modal': true } as const;
  return {};
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]';

/** 지금 Tab으로 갈 수 있는 요소(전송 버튼 disabled가 바뀌므로 매번 조회). */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
}

/** medium 오버레이 포커스 트랩: 끝에서 Tab → 처음, 처음에서 Shift+Tab → 끝(디자인 §7-3). 처리하면 true. */
function trapTab(root: HTMLElement, shiftKey: boolean): boolean {
  const items = focusables(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return false;
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && items.includes(active);
  if (shiftKey && (!inside || active === first)) {
    last.focus();
    return true;
  }
  if (!shiftKey && (!inside || active === last)) {
    first.focus();
    return true;
  }
  return false;
}

/** CMP-13 ThreadPanel — wide `aside` / medium `role="dialog"` 오버레이 / compact 화면(디자인 §7-2, UI_STATES §2-7). */
export function ThreadPanel({ variant, root, replies, onClose, onSend, announce, drafts, onRetry, onDiscard, messageActions, onSeen, spaceTitle }: ThreadPanelProps) {
  const timePlacement: 'inline' | 'below' = variant === 'compact' ? 'below' : 'inline';
  const actions = { timePlacement, ...(onRetry === undefined ? {} : { onRetry }), ...(onDiscard === undefined ? {} : { onDiscard }), ...messageActions };
  const container = useRef<HTMLElement>(null);
  const lastEsc = useRef(0);
  const lastReply = lastServerSeq(replies);
  const reportSeen = () => {
    const el = container.current;
    if (el !== null && lastReply !== undefined && scrolledToBottom(el)) onSeen?.(lastReply);
  };
  useEffect(reportSeen);

  useEffect(() => {
    container.current?.querySelector('textarea')?.focus();
  }, [root.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    // portal(삭제 확인 Dialog 등)에서 React 트리로 전파된 키는 처리하지 않는다(Codex r1 P2).
    if (!(e.target instanceof Node) || container.current?.contains(e.target) !== true) return;
    // 디자인 §7-4 순위 1: 조합 중에는 앱이 어떤 키도 처리하지 않는다.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Tab' && variant === 'medium' && container.current !== null) {
      if (trapTab(container.current, e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key !== 'Escape') return;
    const target = e.target as HTMLElement;
    const typed = target instanceof HTMLTextAreaElement && target.value !== '';
    e.preventDefault();
    if (variant !== 'wide' || !typed) {
      onClose();
      return;
    }
    const now = Date.now();
    if (now - lastEsc.current <= DOUBLE_ESC_WINDOW_MS) {
      lastEsc.current = 0;
      onClose();
      return;
    }
    lastEsc.current = now;
    announce(DOUBLE_ESC_HINT);
  };

  const Tag = variant === 'wide' ? 'aside' : 'section';
  const replyCount = THREAD_SUMMARY_COPY.replies(replies.length);
  const subtitle = spaceTitle === undefined ? replyCount : `${spaceTitle} · ${replyCount}`;
  const closeButton = (
    <button type="button" className="btn btn-secondary thread-close" onClick={onClose}>
      {variant === 'compact' ? '뒤로' : '닫기'}
    </button>
  );
  return (
    <Tag
      ref={container}
      className={`thread-panel thread-${variant}`}
      aria-label="스레드"
      {...variantProps(variant)}
      onKeyDown={onKeyDown}
      onScroll={reportSeen}
    >
      {/* 시안 01·06: 「스레드」 + 「채널 · 답글 n」 보조 + 닫기(compact는 왼쪽 「뒤로」). */}
      <div className="thread-header">
        {variant === 'compact' && closeButton}
        <div className="thread-heading">
          <h2 className="thread-title">스레드</h2>
          <p className="thread-subtitle">{subtitle}</p>
        </div>
        {variant !== 'compact' && closeButton}
      </div>
      <ul className="thread-root">
        {/* 원문이 바뀌면 다시 마운트 — 편집·삭제 확인 상태가 다른 메시지로 이어지지 않게(Codex r1 P1). */}
        <MessageItem key={root.id} message={root} {...actions} />
      </ul>
      {replies.length === 0 ? (
        <p className="thread-empty">{THREAD_EMPTY_TEXT}</p>
      ) : (
        <ul className="thread-replies">
          {replies.map((r) => (
            <MessageItem key={r.id} message={r} {...actions} />
          ))}
        </ul>
      )}
      <Composer
        key={root.id}
        label={COMPOSER_COPY.replyLabel}
        placeholder={COMPOSER_COPY.replyPlaceholder}
        onSend={onSend}
        {...(drafts === undefined ? {} : { draft: { store: drafts, key: root.id } })}
      />
    </Tag>
  );
}
