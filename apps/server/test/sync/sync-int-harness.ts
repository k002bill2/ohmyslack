import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ConversationSummary, ReadStateResponse, SyncResponse } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { req } from '../conversations/conv-int-harness.js';

/** sync·읽음 int 테스트 공통 호출. */
export async function conversations(app: FastifyInstance, session: Session): Promise<ConversationSummary[]> {
  const res = await req(app, 'GET', '/api/conversations', session);
  if (res.statusCode !== 200) throw new Error(`목록 실패: ${res.statusCode}`);
  return res.json<{ conversations: ConversationSummary[] }>().conversations;
}

export async function summary(app: FastifyInstance, session: Session, conversationId: string): Promise<ConversationSummary> {
  const found = (await conversations(app, session)).find((c) => c.id === conversationId);
  if (found === undefined) throw new Error('목록에 대화 없음');
  return found;
}

export function markReadRaw(
  app: FastifyInstance,
  session: Session,
  conversationId: string,
  lastReadSeq: number,
  threadRootId?: string,
): Promise<LightMyRequestResponse> {
  return req(app, 'PUT', '/api/read-state', session, {
    conversation_id: conversationId,
    last_read_seq: lastReadSeq,
    ...(threadRootId === undefined ? {} : { thread_root_id: threadRootId }),
  });
}

export async function markRead(
  app: FastifyInstance,
  session: Session,
  conversationId: string,
  lastReadSeq: number,
  threadRootId?: string,
): Promise<ReadStateResponse> {
  const res = await markReadRaw(app, session, conversationId, lastReadSeq, threadRootId);
  if (res.statusCode !== 200) throw new Error(`읽음 실패: ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function syncPage(app: FastifyInstance, session: Session, query: string): Promise<SyncResponse> {
  const res = await req(app, 'GET', `/api/sync?${query}`, session);
  if (res.statusCode !== 200) throw new Error(`sync 실패: ${res.statusCode} ${res.body}`);
  return res.json();
}

/** after부터 watermark(주어지면 through)까지 페이지를 끝까지 따라간다. 원문 응답 텍스트도 함께 돌려준다. */
export async function syncAll(
  app: FastifyInstance,
  session: Session,
  after: number,
  limit: number,
  through?: number,
): Promise<{ pages: SyncResponse[]; texts: string[] }> {
  const pages: SyncResponse[] = [];
  const texts: string[] = [];
  let query = `after=${after}&limit=${limit}${through === undefined ? '' : `&through=${through}`}`;
  for (let i = 0; i < 1000; i += 1) {
    const res = await req(app, 'GET', `/api/sync?${query}`, session);
    if (res.statusCode !== 200) throw new Error(`sync 실패: ${res.statusCode} ${res.body}`);
    const page = res.json<SyncResponse>();
    pages.push(page);
    texts.push(res.body);
    if (!page.has_more) break;
    query = `after=${page.next_cursor}&through=${page.through_cursor}&limit=${limit}`;
  }
  return { pages, texts };
}
