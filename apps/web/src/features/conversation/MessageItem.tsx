import { MessageBody } from './MessageBody.js';
import { MessageStatus } from './MessageStatus.js';
import type { PendingMessage } from './send-status.js';

export interface MessageItemData {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
  readonly pending?: PendingMessage;
}

export interface MessageItemProps {
  readonly message: MessageItemData;
  /** 있으면 「답글」 버튼을 렌더한다(스레드 닫기 포커스 복귀 대상 — 디자인 §7-3). */
  readonly onReply?: (id: string) => void;
  /** 전송 대기 항목 「다시 시도」·「삭제」(client_message_id). 없으면 버튼이 아무 동작도 하지 않는다. */
  readonly onRetry?: (clientMessageId: string) => void;
  readonly onDiscard?: (clientMessageId: string) => void;
}

const TIME = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

/** 디자인 §7-2 `aria-label="홍길동, 오후 3:12"` 형식(작성자, 시각). */
export function messageLabel(author: string, createdAt: string): string {
  return `${author}, ${TIME.format(new Date(createdAt))}`;
}

/** CMP-07 MessageItem(골격) — 작성자·본문·전송 상태·「답글」. 아바타·스레드 요약·액션 툴바는 다음 레인. */
export function MessageItem({ message, onReply, onRetry, onDiscard }: MessageItemProps) {
  const pending = message.pending;
  return (
    <li className="msg-item" aria-label={messageLabel(message.author, message.createdAt)}>
      <span className="msg-author">{message.author}</span>
      <MessageBody body={message.body} />
      {pending !== undefined && (
        <MessageStatus
          item={pending}
          onRetry={() => onRetry?.(pending.clientMessageId)}
          onDiscard={() => onDiscard?.(pending.clientMessageId)}
        />
      )}
      {onReply !== undefined && (
        <button type="button" data-reply-for={message.id} onClick={() => onReply(message.id)}>
          답글
        </button>
      )}
    </li>
  );
}
