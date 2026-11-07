import type { ConversationSummary } from '../../apps/server/src/shared.js';
import type { Session } from '../../apps/server/test/auth/members-int-harness.js';
import { foldMessage, http, syncFrom, type E2eContext, type FoldState } from './harness.js';
import { WsClient } from './ws-client.js';

/**
 * 전경 복귀 클라이언트 모델: 유효 세션 확인(GET /api/me) → WS 재연결 → 커서 catch-up → 구독 ACK → 목록(읽음).
 * `fresh`는 모든 단계가 끝난 뒤에만 true가 되고, 시작 즉시·실패(서버 불가) 시 false다.
 */
export class ResumeClient {
  fresh = false;
  cursor = 0;
  state: FoldState = new Map();
  summaries: ConversationSummary[] = [];
  private ws: WsClient | undefined;

  constructor(
    private readonly ctx: E2eContext,
    private readonly session: Session,
    private readonly conversationIds: readonly string[],
  ) {}

  /** 백그라운드 전환: 소켓을 닫고 최신 표시를 내린다. */
  async background(): Promise<void> {
    this.fresh = false;
    await this.ws?.close();
    this.ws = undefined;
  }

  async resume(): Promise<boolean> {
    this.fresh = false;
    try {
      await http(this.ctx, 'GET', '/api/me', this.session);
      await this.ws?.close();
      this.ws = await WsClient.open(this.ctx.wsUrl, this.session);
      const catchup = await syncFrom(this.ctx, this.session, this.cursor);
      let state = this.state;
      for (const c of catchup.changes) state = foldMessage(state, c.change_id, c.message);
      for (const id of this.conversationIds) this.ws.subscribe(id, catchup.through);
      await Promise.all(this.conversationIds.map((id) => this.ws?.subscribed(id)));
      const list = await http<{ conversations: ConversationSummary[] }>(this.ctx, 'GET', '/api/conversations', this.session);
      this.state = state;
      this.cursor = catchup.through;
      this.summaries = list.conversations;
      this.fresh = true;
      return true;
    } catch {
      this.fresh = false;
      return false;
    }
  }

  async close(): Promise<void> {
    await this.ws?.close();
  }
}
