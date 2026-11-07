/**
 * 화면 데이터 주입 경계(W-10b). 운영 구현은 `createHttpDataSource`(HTTP + WS, W-10c).
 * 값 필드는 TRD §3 `GET /api/conversations` 항목 필드(unread_count·mention_count·unread_thread_count)와 대응한다.
 */
import type { PendingMessage } from '../features/conversation';

export type SpaceKind = 'channel' | 'dm';

export interface Space {
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly unreadThreadCount: number;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly rootId?: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
  readonly replyCount: number;
  /** 내 전송 대기 항목(전송 중·저장 여부 확인 중·실패). 저장 확인이면 없음. */
  readonly pending?: PendingMessage;
  /** 서버 메시지 필드(HTTP 구현만 채운다). */
  readonly seq?: number;
  readonly authorId?: string;
  readonly clientMessageId?: string;
  readonly deleted?: boolean;
}

/** 디자인 §6-4 연결 상태 4종. */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'catching-up';

/** 내 계정(`GET /api/me` user). role로 owner 전용 진입점을 가린다 — 서버 403이 최종 진실. */
export interface Account {
  readonly id: string;
  readonly displayName: string;
  readonly role: 'owner' | 'member';
}

/** 공간 목록 요청 상태(UI_STATES §2-3 로딩·오류). 없으면 `ready`로 본다(메모리 구현). */
export type ListState = 'loading' | 'ready' | 'error';

export interface Snapshot {
  readonly spaces: readonly Space[];
  readonly messages: readonly Message[];
  readonly connection: ConnectionState;
  readonly account?: Account;
  readonly listState?: ListState;
}

/** 서버 요청 실패: HTTP 상태(+오류 code) 또는 네트워크 오류. */
export type ActionFailure = { readonly status: number; readonly code?: string } | { readonly status: 'network' };

/** 공간 진입 동작 결과. */
export type ActionResult<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & ActionFailure);

export interface DiscoverChannel {
  readonly id: string;
  readonly name: string;
}

export interface Member {
  readonly id: string;
  readonly displayName: string;
  readonly role: 'owner' | 'member';
}

/** `POST /api/invites` 2xx(원문 token은 이 응답에서 한 번만 보인다 — 호출자는 메모리에만 둔다). */
export interface Invite {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * 공간 진입점(W-10g): 채널 만들기·찾기·참여·DM·로그아웃. 성공한 생성·참여·DM은 **목록을 다시 읽은 뒤** 대화 ID를 돌려준다
 * — 호출자는 그 ID로 이동(`open`)만 하면 기존 구독·checkpoint 규칙이 그대로 적용된다.
 */
export interface SpacesApi {
  /** `POST /api/conversations`(owner). 409 name_taken·403 forbidden은 실패로 돌려준다. */
  createChannel?(name: string): Promise<ActionResult<string>>;
  /** `GET /api/conversations/discover` 전 페이지. */
  discoverChannels?(): Promise<ActionResult<readonly DiscoverChannel[]>>;
  /** `POST /api/conversations/:id/join`. */
  joinChannel?(conversationId: string): Promise<ActionResult<string>>;
  /** `GET /api/members`. */
  listMembers?(): Promise<ActionResult<readonly Member[]>>;
  /** `POST /api/dms` — 같은 상대면 서버가 기존 DM ID를 돌려준다(FR-CONV-03). */
  startDm?(userId: string): Promise<ActionResult<string>>;
  /** `POST /api/invites`(owner, W-10h). */
  createInvite?(): Promise<ActionResult<Invite>>;
  /** `POST /api/admin/members/:user_id/deactivate`(owner, W-10h). 204 → ok. */
  deactivateMember?(userId: string): Promise<ActionResult<null>>;
  /** 목록 오류 「다시 시도」 — 복귀 절차 1회. */
  reload?(): void;
  /** `POST /api/auth/logout` → 본문·checkpoint 정리 → 세션 종료. */
  logout?(): Promise<void>;
}

export interface DataSource extends SpacesApi {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  send(target: { readonly conversationId: string; readonly rootId?: string }, body: string): void;
  /** 현재 대화가 바뀔 때 호출(구독·이력 로드). 메모리 구현은 없음. */
  open?(conversationId: string | null): void;
  /** 스레드를 열거나(root id) 닫을 때(null) 호출 — 기존 답글 조회. 메모리 구현은 없음. */
  openThread?(rootId: string | null): void;
  /** 실패·확인 중 전송 항목 다시 시도/삭제(W-10a 전송 FSM). 메모리 구현은 없음. */
  retry?(clientMessageId: string): void;
  discard?(clientMessageId: string): void;
}

export interface MemoryDataSource extends DataSource {
  setConnection(state: ConnectionState): void;
}

/** 메모리 구현(테스트·개발용). 스냅숏은 매 변경마다 새 객체로 교체한다(불변). */
export function createMemoryDataSource(seed: Snapshot): MemoryDataSource {
  let snapshot: Snapshot = Object.freeze({ ...seed });
  let nextId = 0;
  const listeners = new Set<() => void>();
  const replace = (next: Snapshot) => {
    snapshot = Object.freeze(next);
    listeners.forEach((l) => l());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(target, body) {
      nextId += 1;
      const message: Message = {
        id: `local-${nextId}`,
        conversationId: target.conversationId,
        ...(target.rootId === undefined ? {} : { rootId: target.rootId }),
        author: '나',
        createdAt: new Date().toISOString(),
        body,
        replyCount: 0,
      };
      const messages = snapshot.messages.map((m) =>
        m.id === target.rootId ? { ...m, replyCount: m.replyCount + 1 } : m,
      );
      replace({ ...snapshot, messages: [...messages, message] });
    },
    setConnection(connection) {
      replace({ ...snapshot, connection });
    },
  };
}
