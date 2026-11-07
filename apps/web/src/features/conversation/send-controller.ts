import { createPending, transition, type MatchKey, type PendingMessage, type SendEvent } from './send-status.js';

/** 전송 요청 결과. 응답 없는 실패(네트워크 오류·타임아웃 abort)는 `post`가 throw한다. */
export type PostResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly status: number };

export interface PostRequest {
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly body: string;
}

export interface SendControllerDeps {
  readonly me: string;
  readonly post: (req: PostRequest) => Promise<PostResult>;
  readonly newClientMessageId: () => string;
  readonly isOnline: () => boolean;
  readonly onChange: (items: readonly PendingMessage[]) => void;
}

/**
 * 대기 항목(메모리 전용) + HTTP 전송. 자동 재전송 없음 — `post`는 submit·retry 호출마다 정확히 1회.
 * 저장 위치는 클로저 변수뿐이다(DEV_DESIGN §2-2 B7: 지속 저장소 사용 금지).
 */
export function createSendController(deps: SendControllerDeps) {
  let items: readonly PendingMessage[] = [];

  const update = (clientMessageId: string, event: SendEvent) => {
    items = items.map((it) => (it.clientMessageId === clientMessageId ? transition(it, event) : it));
    deps.onChange(items);
  };

  const dispatchPost = async (item: PendingMessage): Promise<void> => {
    const { conversationId, clientMessageId, body } = item;
    let result: PostResult;
    try {
      result = await deps.post({ conversationId, clientMessageId, body });
    } catch {
      update(clientMessageId, { type: 'network-error' });
      return;
    }
    update(clientMessageId, result.ok ? { type: 'http-success', messageId: result.messageId } : { type: 'http-error', status: result.status });
  };

  return {
    items: (): readonly PendingMessage[] => items,
    async submit(conversationId: string, body: string): Promise<void> {
      const item = createPending({
        conversationId,
        authorId: deps.me,
        clientMessageId: deps.newClientMessageId(),
        body,
        online: deps.isOnline(),
      });
      items = [...items, item];
      deps.onChange(items);
      if (item.status === 'sending') await dispatchPost(item);
    },
    async retry(clientMessageId: string): Promise<void> {
      const before = items.find((it) => it.clientMessageId === clientMessageId);
      if (before === undefined) return;
      update(clientMessageId, { type: 'retry' });
      const after = items.find((it) => it.clientMessageId === clientMessageId);
      if (after !== undefined && after.status === 'sending' && before.status !== 'sending') await dispatchPost(after);
    },
    messageCreated(key: MatchKey, messageId: string): void {
      items = items.map((it) => transition(it, { type: 'message-created', key, messageId }));
      deps.onChange(items);
    },
    wsClosed(): void {
      items = items.map((it) => transition(it, { type: 'ws-closed' }));
      deps.onChange(items);
    },
    discard(clientMessageId: string): void {
      items = items.filter((it) => it.clientMessageId !== clientMessageId);
      deps.onChange(items);
    },
  };
}

export type SendController = ReturnType<typeof createSendController>;
