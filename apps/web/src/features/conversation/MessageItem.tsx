import { memo, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../data/index.js';
import { MESSAGE_ACTION_COPY } from '../../ui/copy.js';
import { MessageBody } from './MessageBody.js';
import { DeleteMessageDialog } from './MessageItemDelete.js';
import { MessageEditor } from './MessageItemEditor.js';
import { canModify } from './MessageItemRules.js';
import { ThreadSummary } from './MessageItemThreadSummary.js';
import { MessageStatus } from './MessageStatus.js';
import type { PendingMessage } from './send-status.js';

export interface MessageItemData {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
  readonly pending?: PendingMessage;
  /** 서버 필드(W-10i). 없으면 액션·「(수정됨)」·삭제 자리표시자·스레드 요약을 그리지 않는다. */
  readonly authorId?: string;
  readonly editedAt?: string;
  readonly deleted?: boolean;
  readonly replyCount?: number;
}

export interface MessageItemProps {
  readonly message: MessageItemData;
  /** 있으면 「답글」 버튼을 렌더한다(스레드 닫기 포커스 복귀 대상 — 디자인 §7-3). */
  readonly onReply?: (id: string) => void;
  /** 전송 대기 항목 「다시 시도」·「삭제」(client_message_id). 없으면 버튼이 아무 동작도 하지 않는다. */
  readonly onRetry?: (clientMessageId: string) => void;
  readonly onDiscard?: (clientMessageId: string) => void;
  /** 내 사용자 ID — 본인 메시지에만 수정·삭제를 노출한다(W-10i). */
  readonly selfId?: string;
  readonly onEdit?: (id: string, body: string) => Promise<ActionResult<null>>;
  readonly onDelete?: (id: string) => Promise<ActionResult<null>>;
  /** 있으면 CMP-14 ThreadSummary를 렌더한다(답글 ≥ 1). */
  readonly onOpenThread?: (id: string) => void;
  readonly threadUnread?: boolean;
  readonly threadHolding?: boolean;
  /** 보이는 시각 위치(UI_STATES §3 타임스탬프 행): compact = 본문 아래(`below`), medium·wide = 작성자 옆(`inline`, 기본). */
  readonly timePlacement?: 'inline' | 'below';
}

const TIME = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

/** 디자인 §7-2 `aria-label="홍길동, 오후 3:12"` 형식(작성자, 시각). */
export function messageLabel(author: string, createdAt: string): string {
  return `${author}, ${TIME.format(new Date(createdAt))}`;
}

/**
 * 보이는 시각(기존 TIME 포맷). 항목 aria-label에 이미 시각이 있어 스크린리더 중복 낭독을 막으려 `aria-hidden`.
 * 수정된 메시지는 툴팁(title)에 수정 시각(UI_STATES §2-5 「시간 툴팁에 수정 시각」 — 정본에 문구가 없어 시각만).
 */
function MessageTime({ message, placement }: { readonly message: MessageItemData; readonly placement: 'inline' | 'below' }) {
  return (
    <time
      className={`msg-time msg-time-${placement}`}
      dateTime={message.createdAt}
      aria-hidden="true"
      {...(message.editedAt === undefined ? {} : { title: TIME.format(new Date(message.editedAt)) })}
    >
      {TIME.format(new Date(message.createdAt))}
    </time>
  );
}

/** 본문 자리: 삭제 자리표시자(자리 유지) / 본문 + 「(수정됨)」(UI_STATES §2-5). */
function MessageContent({ message }: { readonly message: MessageItemData }) {
  if (message.deleted === true) return <p className="msg-deleted">{MESSAGE_ACTION_COPY.deleted}</p>;
  return (
    <>
      <MessageBody body={message.body} />
      {message.editedAt !== undefined && (
        <span className="msg-edited" title={message.editedAt}>
          {MESSAGE_ACTION_COPY.edited}
        </span>
      )}
    </>
  );
}

/** CMP-07 MessageItem — 작성자·본문·전송 상태·액션(수정·삭제)·「답글」·CMP-14 스레드 요약. */
function MessageItemView(props: MessageItemProps) {
  const { message, onReply, onRetry, onDiscard, selfId, onEdit, onDelete, onOpenThread } = props;
  const pending = message.pending;
  const placement = props.timePlacement ?? 'inline';
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  /** 삭제 후 포커스는 Dialog가 닫혀 배경 `inert`가 풀린 뒤에 항목으로(UI_STATES §8 I-4). */
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    item.current?.focus();
  }, [confirming]);
  const actionable = canModify(message, selfId);
  const isEditing = editing && actionable && onEdit !== undefined;

  const save = async (body: string) => {
    const result = await (onEdit?.(message.id, body) ?? Promise.resolve({ ok: false as const, status: 403 }));
    if (result.ok) {
      setEditing(false);
      item.current?.focus();
    }
    return result;
  };

  return (
    <li ref={item} tabIndex={-1} className="msg-item" data-message-id={message.id} aria-label={messageLabel(message.author, message.createdAt)}>
      <span className="msg-author">{message.author}</span>
      {placement === 'inline' && <MessageTime message={message} placement="inline" />}
      {isEditing ? (
        <MessageEditor
          initial={message.body}
          onSave={save}
          onCancel={() => {
            setEditing(false);
            item.current?.focus();
          }}
        />
      ) : (
        <MessageContent message={message} />
      )}
      {placement === 'below' && <MessageTime message={message} placement="below" />}
      {/* CMP-14: 원문 아래 별도 줄(액션 줄과 분리, UI_STATES §2-7). */}
      {onOpenThread !== undefined && (message.replyCount ?? 0) >= 1 && (
        <div className="msg-thread">
          <ThreadSummary
            rootId={message.id}
            count={message.replyCount ?? 0}
            unread={props.threadUnread === true}
            holding={props.threadHolding === true}
            onOpen={onOpenThread}
          />
        </div>
      )}
      {pending !== undefined && (
        <MessageStatus
          item={pending}
          onRetry={() => onRetry?.(pending.clientMessageId)}
          onDiscard={() => onDiscard?.(pending.clientMessageId)}
        />
      )}
      {actionable && !isEditing && (
        <div className="msg-actions">
          {onEdit !== undefined && (
            <button type="button" className="msg-action" onClick={() => setEditing(true)}>
              {MESSAGE_ACTION_COPY.edit}
            </button>
          )}
          {onDelete !== undefined && (
            <button type="button" className="msg-action" onClick={() => setConfirming(true)}>
              {MESSAGE_ACTION_COPY.delete}
            </button>
          )}
        </div>
      )}
      {/* 삭제 자리표시자 액션은 「스레드 열기만」(UI_STATES §2-5) — 「답글」 없음, CMP-14는 유지. */}
      {onReply !== undefined && message.deleted !== true && (
        <button type="button" className="msg-action" data-reply-for={message.id} onClick={() => onReply(message.id)}>
          답글
        </button>
      )}
      {confirming && onDelete !== undefined && (
        <DeleteMessageDialog
          onConfirm={() => onDelete(message.id)}
          onClose={() => setConfirming(false)}
          onDeleted={() => {
            refocus.current = true;
            setConfirming(false);
          }}
        />
      )}
    </li>
  );
}

/** props가 얕게 같으면 재렌더하지 않는다(F-1). 본문 재파싱은 MessageBody의 useMemo가 따로 막는다. */
export const MessageItem = memo(MessageItemView);
