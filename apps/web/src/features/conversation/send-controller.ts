import { canRetry, createPending, transition, type MatchKey, type PendingMessage, type SendEvent } from './send-status.js';

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
 * 대기 항목(메모리 전용) + HTTP 전송. `post`는 submit·retry 호출마다 최대 1회.
 * 자동 재전송은 `resendOffline`(온라인 복귀 1회)뿐이다 — 오프라인 표식 항목만, 생성 순서대로 하나씩.
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
      update(clientMessageId, { type: 'network-error', offline: !deps.isOnline() });
      return;
    }
    update(clientMessageId, result.ok ? { type: 'http-success', messageId: result.messageId } : { type: 'http-error', status: result.status });
  };

  const retry = async (clientMessageId: string): Promise<void> => {
    const before = items.find((it) => it.clientMessageId === clientMessageId);
    if (before === undefined) return;
    if (!deps.isOnline()) {
      update(clientMessageId, { type: 'offline-retry' });
      return;
    }
    update(clientMessageId, { type: 'retry' });
    const after = items.find((it) => it.clientMessageId === clientMessageId);
    if (after !== undefined && after.status === 'sending' && before.status !== 'sending') await dispatchPost(after);
  };

  const resendLoop = async (): Promise<void> => {
    const ids = items.filter((it) => it.offline === true).map((it) => it.clientMessageId);
    for (const id of ids) {
      if (!deps.isOnline()) return;
      const cur = items.find((it) => it.clientMessageId === id);
      if (cur?.offline !== true || !canRetry(cur)) continue;
      await retry(id);
    }
  };
  let resending: Promise<void> = Promise.resolve();

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
    retry,
    /**
     * `online` 복귀 때 한 번 호출 — 오프라인 표식 항목을 생성 순서대로 같은 ID로 다시 보낸다.
     * 서버 순서 보존을 위해 직렬이며, 복귀가 겹쳐도 앞 실행이 끝난 뒤 이어서 돈다(Codex r1 P2).
     */
    resendOffline(): Promise<void> {
      const run = resending.then(resendLoop);
      // 한 번의 예외가 이후 복귀의 재전송을 영구히 막지 않게 사슬은 오류를 삼킨다.
      resending = run.catch(() => undefined);
      return run;
    },
    /** 세션 종료(로그아웃·401): 대기 항목을 비워 진행 중인 재전송 루프도 남은 항목을 보내지 않게 한다(Codex r1 P2). */
    reset(): void {
      items = [];
      deps.onChange(items);
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
