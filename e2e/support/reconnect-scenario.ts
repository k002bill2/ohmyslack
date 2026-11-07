import { expect } from 'vitest';
import type { MessageView, WsServerFrame } from '../../apps/server/src/shared.js';
import { as, createChannel, req } from '../../apps/server/test/conversations/conv-int-harness.js';
import { send } from '../../apps/server/test/messages/msg-int-harness.js';
import type { Session } from '../../apps/server/test/auth/members-int-harness.js';
import { foldChange, foldedRows, foldMessage, syncFrom, truth, type E2eContext, type FoldState } from './harness.js';
import { WsClient } from './ws-client.js';

type MsgFrame = Extract<WsServerFrame, { type: 'message.created' | 'message.updated' | 'message.deleted' }>;

function isMsgFrame(f: WsServerFrame): f is MsgFrame {
  return f.type === 'message.created' || f.type === 'message.updated' || f.type === 'message.deleted';
}

async function edit(ctx: E2eContext, s: Session, id: string, body: string): Promise<void> {
  const res = await req(ctx.app, 'PATCH', `/api/messages/${id}`, s, { body });
  if (res.statusCode !== 200) throw new Error(`수정 실패: ${res.statusCode}`);
}

async function remove(ctx: E2eContext, s: Session, id: string): Promise<void> {
  const res = await req(ctx.app, 'DELETE', `/api/messages/${id}`, s);
  if (res.statusCode >= 300) throw new Error(`삭제 실패: ${res.statusCode}`);
}

/** 두 대화에 번갈아 n건 게시 + 일부 수정·삭제. */
async function burst(ctx: E2eContext, s: Session, convs: readonly string[], n: number, tag: string): Promise<MessageView[]> {
  const sent: MessageView[] = [];
  for (let i = 0; i < n; i += 1) sent.push(await send(ctx.app, s, convs[i % convs.length] ?? '', { body: `${tag}-${i}` }));
  for (let i = 3; i < n; i += 17) await edit(ctx, s, sent[i]?.id ?? '', `${tag}-${i}-수정`);
  for (let i = 7; i < n; i += 19) await remove(ctx, s, sent[i]?.id ?? '');
  return sent;
}

function foldWs(state: FoldState, frames: readonly WsServerFrame[]): FoldState {
  let next = state;
  for (const f of frames) {
    if (!isMsgFrame(f)) continue;
    if (f.type === 'message.deleted') {
      next = foldChange(next, f.message_id, { changeId: f.change_id, conversationId: f.conversation_id, seq: f.seq, body: null, deleted: true });
    } else next = foldMessage(next, f.change_id, f.message);
  }
  return next;
}

/**
 * FR-SYNC-02 시나리오: 기기 B 커서 기록 → 단절 → A가 두 대화에 100건+수정·삭제 → (gapMs 대기) →
 * B 복귀(REST catch-up + 두 대화 구독)와 동시에 A가 계속 게시(경합). 최종 접기 상태 = DB 원장.
 */
export async function runReconnectScenario(ctx: E2eContext, gapMs: number): Promise<void> {
  const devA = await as(ctx.app, 'a');
  const devB = await as(ctx.app, 'a');
  const convs = [await createChannel(ctx.app, devA, 'e2e-one'), await createChannel(ctx.app, devA, 'e2e-two')];
  await burst(ctx, devA, convs, 6, 'seed');

  // B: 초기 전체 sync로 기준 상태와 커서를 기록하고 실시간 연결 후 단절.
  const base = await syncFrom(ctx, devB, 0);
  let state: FoldState = new Map();
  for (const c of base.changes) state = foldMessage(state, c.change_id, c.message);
  const cursor = base.through;
  const first = await WsClient.open(ctx.wsUrl, devB);
  await first.close();

  await burst(ctx, devA, convs, 100, 'gap');
  if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));

  // 복귀: WS 재연결·구독과 REST catch-up을 A의 동시 게시와 경합시킨다.
  const ws = await WsClient.open(ctx.wsUrl, devB);
  try {
    const racing = burst(ctx, devA, convs, 30, 'race');
    for (const c of convs) ws.subscribe(c, cursor);
    const [catchup, acks] = await Promise.all([syncFrom(ctx, devB, cursor), Promise.all(convs.map((c) => ws.subscribed(c)))]);
    await racing;

    // 원장의 대화별 최대 change_id까지 live가 도착할 때까지 기다린다.
    const finalSync = await syncFrom(ctx, devB, cursor);
    for (const c of convs) {
      const maxId = Math.max(0, ...finalSync.changes.filter((x) => x.conversation_id === c).map((x) => x.change_id));
      await ws.waitFor(() => {
        const seen = ws.frames().filter((f): f is MsgFrame => isMsgFrame(f) && f.conversation_id === c);
        return seen.some((f) => f.change_id >= maxId);
      }, 15_000);
    }

    // 프로토콜 순서: replay(≤through)는 ACK 전, live(>through)는 ACK 후. 구독 내 change_id 중복 0.
    const frames = ws.frames();
    convs.forEach((c, k) => {
      const through = acks[k]?.through_cursor ?? -1;
      const ackIdx = frames.findIndex((f) => f.type === 'conversation.subscribed' && f.conversation_id === c);
      const mine = frames.map((f, i) => ({ f, i })).filter((x): x is { f: MsgFrame; i: number } => isMsgFrame(x.f) && x.f.conversation_id === c);
      for (const { f, i } of mine) {
        if (i < ackIdx) expect(f.change_id).toBeLessThanOrEqual(through);
        else expect(f.change_id).toBeGreaterThan(through);
        expect(f.change_id).toBeGreaterThan(cursor);
      }
      const ids = mine.map((x) => x.f.change_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    for (const ch of catchup.changes) state = foldMessage(state, ch.change_id, ch.message);
    state = foldWs(state, frames);
    const expected = await truth(ctx, convs);
    const actual = foldedRows(state, convs);
    expect(expected.length).toBe(6 + 100 + 30);
    expect(new Set(actual.map((r) => r.id)).size).toBe(actual.length);
    expect(actual).toEqual(expected);
  } finally {
    await ws.close();
  }
}
