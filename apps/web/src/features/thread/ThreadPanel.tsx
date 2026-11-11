import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { COMPOSER_COPY, THREAD_EMPTY_TEXT, THREAD_SUMMARY_COPY } from '../../ui/copy.js';
import { Composer, ComposerNotice, MessageItem, lastServerSeq, scrolledToBottom, type DraftStore, type MessageItemData, type MessageItemProps } from '../conversation';

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
  readonly messageActions?: Pick<MessageItemProps, 'selfId' | 'onEdit' | 'onDelete' | 'messageLink'>;
  /** FR-SYNC-03: 패널이 맨 아래(마지막 답글이 보임)일 때 그 답글 seq를 알린다. 답글이 없으면 부르지 않는다(본문 열기 ≠ 답글 읽음). */
  readonly onSeen?: (seq: number) => void;
  /** 헤더 보조 줄 「채널 · 답글 n」의 채널 이름(시안 01·06). 없으면 「답글 n」만. */
  readonly spaceTitle?: string;
  /** 본문 `@이름` 토큰 근거(대화 멤버 이름) — 대화 목록과 같은 소스(Codex r2 P2). */
  readonly mentionNames?: readonly string[];
  /** 「나를 멘션」 판정 — 대화 목록과 같은 규칙. */
  readonly mentionsSelf?: (message: MessageItemData) => boolean;
  /** 헤더 아래 안내(알림 탭 대상 없음 등, W-23b). */
  readonly notice?: ReactNode;
  /** 있으면 답글 작성기 대신 이 안내를 둔다(G-52 비활성 상대 DM). 원문·답글 읽기는 그대로. */
  readonly composerNotice?: string;
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
export function ThreadPanel({ variant, root, replies, onClose, onSend, announce, drafts, onRetry, onDiscard, messageActions, onSeen, spaceTitle, mentionNames, mentionsSelf, notice, composerNotice }: ThreadPanelProps) {
  const timePlacement: 'inline' | 'below' = variant === 'compact' ? 'below' : 'inline';
  const actions = {
    timePlacement,
    ...(onRetry === undefined ? {} : { onRetry }),
    ...(onDiscard === undefined ? {} : { onDiscard }),
    ...(mentionNames === undefined ? {} : { mentionNames }),
    ...messageActions,
  };
  const selfMention = (m: MessageItemData) => mentionsSelf?.(m) === true;
  const container = useRef<HTMLElement>(null);
  const lastEsc = useRef(0);
  const lastReply = lastServerSeq(replies);
  const reportSeen = () => {
    const el = container.current;
    if (el !== null && lastReply !== undefined && scrolledToBottom(el)) onSeen?.(lastReply);
  };
  useEffect(reportSeen);

  useEffect(() => {
    // 작성기가 없으면(G-52) 닫기 버튼으로 — medium 오버레이에서 포커스가 inert 본문에 남지 않게.
    const el = container.current;
    (el?.querySelector('textarea') ?? el?.querySelector<HTMLElement>('.thread-close'))?.focus();
  }, [root.id]);

  // 열린 스레드에서 작성기가 안내로 바뀌면(403 뒤 비활성 확인) 지워진 입력란의 포커스를 닫기 버튼으로(Codex r2 P2).
  const locked = composerNotice !== undefined;
  const wasLocked = useRef(locked);
  useEffect(() => {
    const active = document.activeElement;
    if (locked && !wasLocked.current && (active === null || active === document.body)) {
      container.current?.querySelector<HTMLElement>('.thread-close')?.focus();
    }
    wasLocked.current = locked;
  }, [locked]);

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
  // R4 시안: wide·medium은 X 아이콘 버튼(접근 이름 「닫기」 그대로), compact는 글자 「뒤로」 유지.
  const closeButton =
    variant === 'compact' ? (
      <button type="button" className="btn btn-secondary thread-close" onClick={onClose}>
        뒤로
      </button>
    ) : (
      <button type="button" className="thread-close thread-close-icon" aria-label="닫기" title="닫기" onClick={onClose}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
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
      {notice}
      <ul className="thread-root">
        {/* 원문이 바뀌면 다시 마운트 — 편집·삭제 확인 상태가 다른 메시지로 이어지지 않게(Codex r1 P1). */}
        <MessageItem key={root.id} message={root} {...actions} mentionsSelf={selfMention(root)} />
      </ul>
      {replies.length === 0 ? (
        <p className="thread-empty">{THREAD_EMPTY_TEXT}</p>
      ) : (
        <ul className="thread-replies">
          {replies.map((r) => (
            <MessageItem key={r.id} message={r} {...actions} mentionsSelf={selfMention(r)} />
          ))}
        </ul>
      )}
      {composerNotice !== undefined ? (
        <ComposerNotice text={composerNotice} />
      ) : (
        <Composer
          key={root.id}
          label={COMPOSER_COPY.replyLabel}
          placeholder={COMPOSER_COPY.replyPlaceholder}
          showHint={variant !== 'compact'}
          onSend={onSend}
          {...(drafts === undefined ? {} : { draft: { store: drafts, key: root.id } })}
        />
      )}
    </Tag>
  );
}
