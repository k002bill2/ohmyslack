import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Composer, MessageItem, type MessageItemData } from '../conversation';

export type ThreadVariant = 'wide' | 'medium' | 'compact';

export interface ThreadPanelProps {
  readonly variant: ThreadVariant;
  readonly root: MessageItemData;
  readonly replies: readonly MessageItemData[];
  readonly onClose: () => void;
  readonly onSend: (body: string) => void;
  /** StatusRegion(CMP-16) 안내. */
  readonly announce: (text: string) => void;
}

/** 디자인 §7-3: wide 작성기에 입력이 있으면 1.5초 안에 Esc 2회로 닫는다. */
export const DOUBLE_ESC_WINDOW_MS = 1500;
export const DOUBLE_ESC_HINT = '닫으려면 Esc를 한 번 더 누르세요';

function variantProps(variant: ThreadVariant) {
  if (variant === 'medium') return { role: 'dialog', 'aria-modal': true } as const;
  return {};
}

/** CMP-13 ThreadPanel — wide `aside` / medium `role="dialog"` 오버레이 / compact 화면(디자인 §7-2, UI_STATES §2-7). */
export function ThreadPanel({ variant, root, replies, onClose, onSend, announce }: ThreadPanelProps) {
  const container = useRef<HTMLElement>(null);
  const lastEsc = useRef(0);

  useEffect(() => {
    container.current?.querySelector('textarea')?.focus();
  }, [root.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // 디자인 §7-4 순위 1: 조합 중에는 앱이 어떤 키도 처리하지 않는다.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
  return (
    <Tag
      ref={container}
      className={`thread-panel thread-${variant}`}
      aria-label="스레드"
      {...variantProps(variant)}
      onKeyDown={onKeyDown}
    >
      <div className="thread-header">
        <button type="button" onClick={onClose}>
          {variant === 'compact' ? '뒤로' : '닫기'}
        </button>
      </div>
      <ul className="thread-root">
        <MessageItem message={root} />
      </ul>
      {replies.length === 0 ? (
        <p className="thread-empty">첫 답글</p>
      ) : (
        <ul className="thread-replies">
          {replies.map((r) => (
            <MessageItem key={r.id} message={r} />
          ))}
        </ul>
      )}
      <Composer key={root.id} label="답글" onSend={onSend} />
    </Tag>
  );
}
