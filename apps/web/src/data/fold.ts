/**
 * 서버 변경 → 화면 메시지 상태 병합(순수). TRD §4: 적용 키는 `change_id` — live·replay·REST catch-up이
 * 같은 변경을 여러 번 보내도 한 번만 반영한다. 반환값은 항상 새 객체(입력 불변).
 */
import type { MessageView } from '../../../../packages/shared/src/index.js';
import type { Message } from './index.js';

export interface FoldState {
  /** message id → 마지막으로 반영한 change_id(이력 응답처럼 change_id가 없으면 0). */
  readonly applied: ReadonlyMap<string, number>;
  readonly messages: ReadonlyMap<string, Message>;
}

export const emptyFold: FoldState = Object.freeze({ applied: new Map(), messages: new Map() });

export type AuthorName = (authorId: string) => string;

function toMessage(view: MessageView, prev: Message | undefined, author: AuthorName): Message {
  return {
    id: view.id,
    conversationId: view.conversation_id,
    ...(view.thread_root_id === null ? {} : { rootId: view.thread_root_id }),
    author: author(view.author_id),
    createdAt: view.created_at,
    body: view.body ?? '',
    // 원문의 root_reply_count가 오면 그 값이 정본(TRD §4). 오지 않으면 이전 값을 유지한다.
    replyCount: typeof view.root_reply_count === 'number' ? view.root_reply_count : (prev?.replyCount ?? 0),
    seq: view.seq,
    authorId: view.author_id,
    clientMessageId: view.client_message_id,
    deleted: view.deleted_at !== null,
    ...(view.edited_at === null ? {} : { editedAt: view.edited_at }),
  };
}

/** `changeId`가 이미 반영한 값 이하이면 그대로 돌려준다(멱등). */
export function foldMessage(state: FoldState, changeId: number, view: MessageView, author: AuthorName): FoldState {
  const seen = state.applied.get(view.id);
  if (seen !== undefined && changeId <= seen) return state;
  const applied = new Map(state.applied).set(view.id, changeId);
  const messages = new Map(state.messages).set(view.id, toMessage(view, state.messages.get(view.id), author));
  return { applied, messages };
}

export interface DeletedFrame {
  readonly change_id: number;
  readonly message_id: string;
  readonly deleted_at: string;
}

/** 삭제: 본문 없는 tombstone으로 바꾼다. 모르는 메시지면 무시(다음 catch-up이 tombstone을 준다). */
export function foldDeleted(state: FoldState, frame: DeletedFrame): FoldState {
  const seen = state.applied.get(frame.message_id);
  const prev = state.messages.get(frame.message_id);
  if (prev === undefined || (seen !== undefined && frame.change_id <= seen)) return state;
  const applied = new Map(state.applied).set(frame.message_id, frame.change_id);
  const messages = new Map(state.messages).set(frame.message_id, { ...prev, body: '', deleted: true });
  return { applied, messages };
}

/** 화면 순서: 대화별 seq 오름차순. */
export function orderedMessages(state: FoldState): readonly Message[] {
  return [...state.messages.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
