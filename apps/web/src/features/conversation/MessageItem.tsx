import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ActionResult } from '../../data/index.js';
import { BotBadge, withBotLabel } from '../../ui/BotBadge.js';
import { NameParts } from '../../ui/NameParts.js';
import { MESSAGE_ACTION_COPY, MESSAGE_MENU_COPY } from '../../ui/copy.js';
import { CONVERSATION_DESIGN_COPY } from '../../ui/copy.js';
import { MessageBody } from './MessageBody.js';
import { AttachmentList } from './attachments/index.js';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { MessageActionSheet, useLongPress, type MessageSheetAction } from './MessageActionSheet.js';
import { DeleteMessageDialog } from './MessageItemDelete.js';
import { MessageEditor } from './MessageItemEditor.js';
import { canModify } from './MessageItemRules.js';
import { ThreadSummary } from './MessageItemThreadSummary.js';
import { MessageItemToolbar, useMessageMenu } from './MessageItemToolbar.js';
import { MessageStatus } from './MessageStatus.js';
import { messageKeyAction, useRovingInner } from './message-keys.js';
import type { PendingMessage } from './send-status.js';

export interface MessageItemData {
  readonly id: string;
  readonly author: string;
  /** 비활성 작성자면 접미 없는 이름 — 이름·「(비활성)」을 따로 그려 접미가 중간에서 끊기지 않게 한다(QA D2). */
  readonly authorInactiveName?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly pending?: PendingMessage;
  /** 서버 필드(W-10i). 없으면 액션·「(수정됨)」·삭제 자리표시자·스레드 요약을 그리지 않는다. */
  readonly authorId?: string;
  readonly editedAt?: string;
  readonly deleted?: boolean;
  readonly replyCount?: number;
  /** 서버 `author_kind`(W-19b). `bot`이면 작성자 옆 CMP-26 배지 — 표시 이름으로 판정하지 않는다. */
  readonly authorKind?: 'human' | 'bot';
  /** 서버 `attachments`(W-22). 삭제 자리표시자에서는 그리지 않는다. */
  readonly attachments?: readonly AttachmentView[];
}

export interface MessageItemProps {
  readonly message: MessageItemData;
  /** 있으면 「답글」 버튼을 렌더한다(스레드 닫기 포커스 복귀 대상 — 디자인 §7-3). */
  readonly onReply?: (id: string) => void;
  /** 전송 대기 항목 「다시 시도」·「삭제」(client_message_id). 없으면 버튼이 아무 동작도 하지 않는다. */
  readonly onRetry?: (clientMessageId: string) => void;
  readonly onDiscard?: (clientMessageId: string) => void;
  /** true면 「전송 실패」 항목에 「다시 시도」를 숨긴다(G-52 잠긴 DM, 「삭제」만). 판정은 호출자가 한다. */
  readonly retryLocked?: boolean;
  /** 내 사용자 ID — 본인 메시지에만 수정·삭제를 노출한다(W-10i). */
  readonly selfId?: string;
  readonly onEdit?: (id: string, body: string) => Promise<ActionResult<null>>;
  readonly onDelete?: (id: string) => Promise<ActionResult<null>>;
  /** 있으면 CMP-14 ThreadSummary를 렌더한다(답글 ≥ 1). */
  readonly onOpenThread?: (id: string) => void;
  readonly threadUnread?: boolean;
  readonly threadHolding?: boolean;
  /** 이 메시지가 지금 열린 스레드의 루트인가(시안 01 칩 강조). 판정은 호출자가 한다. */
  readonly threadActive?: boolean;
  /** 보이는 시각 위치(UI_STATES §3 타임스탬프 행): compact = 본문 아래(`below`), medium·wide = 작성자 옆(`inline`, 기본). */
  readonly timePlacement?: 'inline' | 'below';
  /** 나를 멘션한 메시지면 강조 블록 + 「나를 멘션」 라벨(시안 01). 판정은 호출자(목록)가 한다. */
  readonly mentionsSelf?: boolean;
  /** 본문 `@이름` 토큰 근거(대화 멤버 표시 이름, W-11d). 호출자가 안정 참조로 넘긴다. */
  readonly mentionNames?: readonly string[];
  /**
   * 메시지 액션 표면(시안 08 / UI_STATES §3 메시지 액션): `toolbar` = hover·포커스 인라인 툴바(medium·wide),
   * `sheet` = 길게 누르기·「메시지 작업」 버튼 → 액션 시트(compact). 기본은 `timePlacement === 'below'`면 `sheet`.
   */
  readonly actionMode?: 'toolbar' | 'sheet';
  /**
   * 메시지 목록 roving tabindex(UI_STATES §4-1): `true` = 이 항목이 목록의 Tab 정류장(tabIndex 0),
   * `false` = 정류장 아님(안의 조작도 Tab에서 뺀다). 없으면(스레드 패널 등) 기존처럼 tabIndex -1.
   */
  readonly rovingActive?: boolean;
  /** 이 메시지로 바로 가는 주소(R4 메뉴 「메시지 링크 복사」). 없으면 그 항목을 렌더하지 않는다. */
  readonly messageLink?: (id: string) => string;
}

/** 클립보드 쓰기(없거나 거부되면 false). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 복사 결과 안내를 잠깐 보였다가 지운다(role=status, 포커스 이동 없음 — D §7-1 4.1.3). */
const COPY_NOTE_MS = 1600;

const TIME = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

/** 디자인 §7-2 `aria-label="홍길동, 오후 3:12"` 형식(작성자, 시각). */
export function messageLabel(author: string, createdAt: string, bot = false): string {
  return `${withBotLabel(author, bot)}, ${TIME.format(new Date(createdAt))}`;
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
function MessageContent({ message, mentionNames }: { readonly message: MessageItemData; readonly mentionNames?: readonly string[] | undefined }) {
  if (message.deleted === true) return <p className="msg-deleted">{MESSAGE_ACTION_COPY.deleted}</p>;
  return (
    <>
      <MessageBody body={message.body} {...(mentionNames === undefined ? {} : { mentionNames })} />
      {message.attachments !== undefined && <AttachmentList attachments={message.attachments} />}
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
  const [sheetOpen, setSheetOpen] = useState(false);
  /** 시트에서 고른 동작 — 시트가 언마운트(포커스 복귀·inert 해제)된 뒤 적용해 Dialog를 겹치지 않는다. */
  const [pendingAction, setPendingAction] = useState<MessageSheetAction | null>(null);
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
  // 저장 전(pending) 메시지는 서버 id가 없어 스레드 루트가 될 수 없다 — 임시 id가 thread_root_id로 나가 400이 된다.
  const showReply = onReply !== undefined && message.deleted !== true && pending === undefined;
  const mentioned = props.mentionsSelf === true && message.deleted !== true;
  const sheetMode = (props.actionMode ?? (placement === 'below' ? 'sheet' : 'toolbar')) === 'sheet';
  const canEdit = actionable && !isEditing && onEdit !== undefined;
  const canDelete = actionable && !isEditing && onDelete !== undefined;
  useRovingInner(item, props.rovingActive);
  /** 복사(텍스트·링크) 가능 조건 — 툴바 메뉴와 compact 액션 시트가 같은 판정을 쓴다. */
  const copyable = message.deleted !== true && pending === undefined && !isEditing;
  const { messageLink } = props;
  const canCopyLink = copyable && messageLink !== undefined;
  const hasActions = showReply || (actionable && !isEditing) || copyable;
  const menuEnabled = !sheetMode && copyable;
  const menu = useMessageMenu(item, menuEnabled);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  useEffect(() => {
    if (copyNote === null) return;
    const t = setTimeout(() => setCopyNote(null), COPY_NOTE_MS);
    return () => clearTimeout(t);
  }, [copyNote]);
  const copy = (text: string, done: string) => {
    void writeClipboard(text).then((ok) => setCopyNote(ok ? done : MESSAGE_MENU_COPY.copyFailed));
  };
  /** D §7-3 메시지 단축키 — compact는 키맵 대신 보이는 버튼(액션 시트)이라 끈다. */
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (sheetMode || menu.onItemKey(e)) return;
    const action = messageKeyAction(e, { reply: showReply && onReply !== undefined, edit: canEdit, delete: canDelete });
    if (action === null) return;
    e.preventDefault();
    if (action === 'reply') onReply?.(message.id);
    else if (action === 'edit') setEditing(true);
    else setConfirming(true);
  };

  useEffect(() => {
    if (sheetOpen || pendingAction === null) return;
    setPendingAction(null);
    if (pendingAction === 'reply') onReply?.(message.id);
    else if (pendingAction === 'edit') setEditing(true);
    else if (pendingAction === 'delete') setConfirming(true);
  }, [sheetOpen, pendingAction, onReply, message.id]);

  const longPress = useLongPress(sheetMode && hasActions && !sheetOpen, () => {
    // Dialog는 마운트 시 activeElement를 복귀 대상으로 잡는다 — 길게 누르기로 열면 항목으로 돌아오게.
    item.current?.focus();
    setSheetOpen(true);
  });
  const itemClass = ['msg-item', mentioned ? 'msg-mentioned' : '', sheetMode ? 'msg-item-sheet' : ''].filter(Boolean).join(' ');

  const save = async (body: string) => {
    const result = await (onEdit?.(message.id, body) ?? Promise.resolve({ ok: false as const, status: 403 }));
    if (result.ok) {
      setEditing(false);
      item.current?.focus();
    }
    return result;
  };

  return (
    <li
      ref={item}
      tabIndex={props.rovingActive === true ? 0 : -1}
      className={itemClass}
      onKeyDown={onKeyDown}
      data-message-id={message.id}
      aria-label={messageLabel(message.author, message.createdAt, message.authorKind === 'bot')}
      onContextMenu={menu.onContextMenu}
      {...longPress}
    >
      {/* 배지는 작성자 span 안 — msg-item은 flex-wrap이라 형제로 두면 좁은 폭에서 배지만 다음 줄로 갈 수 있다.
          비활성이면 접미 「(비활성)」과 배지를 한 nowrap 묶음으로(NameParts tail, 봇 배지 QA D-1). */}
      <span className="msg-author">
        <NameParts
          label={message.author}
          inactiveName={message.authorInactiveName}
          tail={message.authorKind === 'bot' ? <BotBadge /> : undefined}
        />
      </span>
      {placement === 'inline' && <MessageTime message={message} placement="inline" />}
      {mentioned && <span className="msg-mention-label">{CONVERSATION_DESIGN_COPY.mentionedSelf}</span>}
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
        <MessageContent message={message} mentionNames={props.mentionNames} />
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
            active={props.threadActive === true}
            onOpen={onOpenThread}
          />
        </div>
      )}
      {pending !== undefined && (
        <MessageStatus
          item={pending}
          onRetry={() => onRetry?.(pending.clientMessageId)}
          onDiscard={() => onDiscard?.(pending.clientMessageId)}
          failedRetry={props.retryLocked !== true}
        />
      )}
      {/* 시안 11 A·B: hover·포커스 시 메시지 오른쪽 위 툴바(정본 UI_STATES §3 「hover·포커스 시 인라인 툴바」). 대표 동작 「답글」 먼저. */}
      {/* 시안 08 / UI_STATES §3 메시지 액션(compact): 인라인 툴바 대신 길게 누르기 + 접근성 대체 버튼 → 액션 시트.
          인라인 「답글」이 없으므로 스레드 닫기 포커스 복귀 대상(data-reply-for)은 이 버튼이 맡는다. */}
      {sheetMode && hasActions && (
        <button
          type="button"
          className="msg-sheet-trigger"
          {...(showReply ? { 'data-reply-for': message.id } : {})}
          onClick={() => setSheetOpen(true)}
        >
          {CONVERSATION_DESIGN_COPY.messageActions}
        </button>
      )}
      {sheetOpen && (
        <MessageActionSheet
          author={message.author}
          body={message.body}
          canReply={showReply}
          canEdit={canEdit}
          canDelete={canDelete}
          canCopyText={copyable}
          canCopyLink={canCopyLink}
          onClose={() => setSheetOpen(false)}
          onSelect={(action) => {
            setSheetOpen(false);
            // 복사는 클립보드 사용자 동작(클릭) 안에서 바로 — 언마운트 뒤 effect로 미루면 일부 브라우저가 거부한다.
            if (action === 'copy-text') copy(message.body, MESSAGE_MENU_COPY.copiedText);
            else if (action === 'copy-link') {
              if (messageLink !== undefined) copy(messageLink(message.id), MESSAGE_MENU_COPY.copiedLink);
            } else setPendingAction(action);
          }}
        />
      )}
      {/* R4 시안 툴바(Floating-Menus A·B): 「답글」 글자 + 수정·더보기 아이콘, 더보기·우클릭·Shift+F10 → 메시지 메뉴. */}
      {!sheetMode && (
        <MessageItemToolbar
          messageId={message.id}
          caps={{ reply: showReply, edit: canEdit, delete: canDelete, menu: menuEnabled }}
          actions={{
            onReply: () => onReply?.(message.id),
            onEdit: () => setEditing(true),
            onDelete: () => setConfirming(true),
            onCopyText: () => copy(message.body, MESSAGE_MENU_COPY.copiedText),
            ...(messageLink === undefined ? {} : { onCopyLink: () => copy(messageLink(message.id), MESSAGE_MENU_COPY.copiedLink) }),
          }}
          menu={menu}
        />
      )}
      {copyNote !== null && (
        <span className="msg-copy-note" role="status">
          {copyNote}
        </span>
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
