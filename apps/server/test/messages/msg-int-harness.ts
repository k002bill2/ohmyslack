import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { MessageView } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { req } from '../conversations/conv-int-harness.js';

/** 메시지 int 테스트 공통 호출. 대화·행위자 준비는 conv-int-harness를 그대로 쓴다. */
export interface SendBody {
  readonly client_message_id?: string;
  readonly body?: string;
  readonly thread_root_id?: string | null;
  readonly mention_user_ids?: readonly string[];
}

export function sendRaw(app: FastifyInstance, session: Session, conversationId: string, body: SendBody): Promise<LightMyRequestResponse> {
  return req(app, 'POST', `/api/conversations/${conversationId}/messages`, session, {
    client_message_id: randomUUID(),
    body: 'hello',
    ...body,
  } as Record<string, unknown>);
}

export async function send(app: FastifyInstance, session: Session, conversationId: string, body: SendBody = {}): Promise<MessageView> {
  const res = await sendRaw(app, session, conversationId, body);
  if (res.statusCode !== 201) throw new Error(`전송 실패: ${res.statusCode} ${res.body}`);
  return res.json<{ message: MessageView }>().message;
}

export async function history(app: FastifyInstance, session: Session, conversationId: string, query = ''): Promise<{ messages: MessageView[]; has_more: boolean }> {
  const res = await req(app, 'GET', `/api/conversations/${conversationId}/messages${query}`, session);
  if (res.statusCode !== 200) throw new Error(`이력 실패: ${res.statusCode}`);
  return res.json();
}

export async function replies(
  app: FastifyInstance,
  session: Session,
  rootId: string,
  query = '',
): Promise<{ root: MessageView; replies: MessageView[]; has_more: boolean }> {
  const res = await req(app, 'GET', `/api/messages/${rootId}/replies${query}`, session);
  if (res.statusCode !== 200) throw new Error(`답글 실패: ${res.statusCode}`);
  return res.json();
}
