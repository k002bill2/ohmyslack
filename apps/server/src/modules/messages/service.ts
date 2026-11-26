import { randomUUID } from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import type { AccessAction, ConversationsService } from '../conversations/service.js';
import type { MessageEvents } from './events.js';
import { toPreviewText } from './preview.js';
import type { MessageLocator, MessageRecord, MessagesStore, Page, PageRequest, WriteResult } from './store.js';

export interface MessagesServiceDeps {
  readonly store: MessagesStore;
  readonly conversations: ConversationsService;
  readonly events: MessageEvents;
  readonly clock: () => number;
}

export interface SendInput {
  readonly clientMessageId: string;
  readonly body: string;
  readonly threadRootId: string | null;
  readonly mentionUserIds: readonly string[];
  readonly attachmentIds?: readonly string[];
}

export interface WriteOutcome {
  readonly message: MessageRecord;
  readonly changeId: number;
  /** 새로 만들었으면 true, 멱등 재시도면 false. */
  readonly created: boolean;
}

export interface MessagesService {
  /**
   * `message` 메타 라우트의 접근 판정(B2): 메시지 ID로 대화를 해석한 뒤 `conversations.service.assertAccess` **하나**로 판정한다.
   * 없는 메시지는 존재를 숨기고 404.
   */
  resolveAccess(userId: string, messageId: string, action: AccessAction): Promise<MessageLocator>;
  send(authorId: string, conversationId: string, input: SendInput): Promise<WriteOutcome>;
  edit(editorId: string, messageId: string, body: string, mentionUserIds: readonly string[]): Promise<WriteOutcome>;
  remove(actorId: string, messageId: string): Promise<WriteOutcome>;
  history(conversationId: string, page: PageRequest): Promise<Page>;
  replies(rootId: string, page: PageRequest): Promise<{ readonly root: MessageRecord; readonly page: Page }>;
  /** 알림 미리보기 평문(TRD §6-2). 삭제·평문 없음이면 null. 접근 판정은 호출자의 messageGuard가 먼저 한다. */
  preview(messageId: string): Promise<string | null>;
}

const notFound = (): HttpError => new HttpError(404, 'not_found');

function written(result: WriteResult): { readonly message: MessageRecord; readonly changeId: number; readonly root?: MessageRecord } {
  if (result.kind === 'forbidden') throw new HttpError(403, 'forbidden');
  if (result.kind === 'not_found') throw notFound();
  return result;
}

/** 이벤트는 store가 commit하고 돌아온 **뒤**에만 발행한다(B3). 롤백·예외 경로는 이벤트 0건. */
export function createMessagesService(deps: MessagesServiceDeps): MessagesService {
  const { store, conversations, events, clock } = deps;
  const now = (): Date => new Date(clock());
  /**
   * 답글 생성·삭제 뒤 원문의 현재 상태(root_reply_count)를 같은 change_id의 updated로 알린다(TRD §4).
   * sync scan도 원문을 답글의 change_id로 접어 싣으므로 replay와 live가 같은 커서를 쓴다. 답글 이벤트 **뒤**에 발행한다.
   * 이미 삭제된 원문은 보내지 않는다: replay도 삭제 원문은 message.deleted(수 없음)로 내므로 updated로 되살리지 않는다.
   */
  const emitRoot = (changeId: number, root: MessageRecord | undefined): void => {
    if (root !== undefined && root.deletedAt === null) events.updated({ changeId, message: root });
  };

  return {
    async resolveAccess(userId, messageId, action) {
      const located = await store.locate(messageId);
      if (located === undefined) throw notFound();
      await conversations.assertAccess(userId, located.conversationId, action);
      return located;
    },
    async send(authorId, conversationId, input) {
      const result = await store.send({ id: randomUUID(), conversationId, authorId, ...input, at: now() });
      if (result.kind === 'conflict') throw new HttpError(409, 'idempotency_conflict');
      if (result.kind === 'bad_root') throw new HttpError(400, 'invalid_thread_root');
      if (result.kind === 'bad_attachments') throw new HttpError(400, 'invalid_attachments');
      if (result.kind === 'not_member') throw notFound();
      if (result.kind === 'peer_inactive') throw new HttpError(403, 'forbidden');
      if (result.kind === 'created') {
        events.created({ changeId: result.changeId, message: result.message });
        emitRoot(result.changeId, result.root);
      }
      return { message: result.message, changeId: result.changeId, created: result.kind === 'created' };
    },
    async edit(editorId, messageId, body, mentionUserIds) {
      const result = written(await store.edit({ id: messageId, editorId, body, mentionUserIds, at: now() }));
      events.updated(result);
      return { ...result, created: false };
    },
    async remove(actorId, messageId) {
      const { root, ...result } = written(await store.remove(messageId, actorId, now()));
      const { message } = result;
      events.deleted({
        changeId: result.changeId,
        conversationId: message.conversationId,
        messageId: message.id,
        seq: message.seq,
        deletedAt: message.deletedAt ?? now(),
      });
      emitRoot(result.changeId, root);
      return { ...result, created: false };
    },
    history: (conversationId, page) => store.history(conversationId, page),
    async replies(rootId, page) {
      const root = await store.get(rootId);
      if (root === undefined) throw notFound();
      if (root.threadRootId !== null) throw new HttpError(400, 'invalid_thread_root');
      return { root, page: await store.replies(rootId, page) };
    },
    async preview(messageId) {
      const message = await store.get(messageId);
      if (message === undefined) throw notFound();
      return message.deletedAt !== null || message.body === null ? null : toPreviewText(message.body);
    },
  };
}
