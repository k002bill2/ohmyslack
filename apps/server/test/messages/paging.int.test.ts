import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageView } from '../../src/shared.js';
import { HISTORY_LIMIT_MAX } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { history, replies, send } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

/** 동시 전송 단계의 총 전송 수(원문+답글). */
const TOTAL_SENDS = 10_000;
/** 답글 대상이 될 사전 원문 수. */
const PRE_ROOTS = 20;
/** 동시에 in-flight인 전송 수 상한. */
const CONCURRENCY = Number(process.env.PAGING_CONC ?? 24);
/** 사용자당 세션 수(세션 행 경합 분산). */
const SESSIONS_PER_USER = 3;
/** 역방향 페이징을 시작하기 전 커밋돼 있어야 할 전송 수. */
const PAGING_START_AFTER = 2_000;

const pageQuery = (cursor: string): string => `?${cursor}&limit=${HISTORY_LIMIT_MAX}`;

interface Page {
  readonly messages: MessageView[];
  readonly has_more: boolean;
}

/** 페이지 공통 단언: limit 이하, 원문만, seq 오름차순, has_more면 꽉 찬 페이지(답글이 페이지 크기를 쓰지 않음). */
function checkHistoryPage(page: Page): void {
  expect(page.messages.length).toBeLessThanOrEqual(HISTORY_LIMIT_MAX);
  for (const m of page.messages) expect(m.thread_root_id).toBeNull();
  const seqs = page.messages.map((m) => m.seq);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  if (page.has_more) expect(page.messages).toHaveLength(HISTORY_LIMIT_MAX);
}

/** 한 스레드의 답글 전체를 after_seq 정방향으로 모은다. */
async function allReplies(session: Session, rootId: string): Promise<MessageView[]> {
  const out: MessageView[] = [];
  let cursor = 0;
  for (;;) {
    const page = await replies(ctx.app, session, rootId, pageQuery(`after_seq=${cursor}`));
    expect(page.replies.length).toBeLessThanOrEqual(HISTORY_LIMIT_MAX);
    out.push(...page.replies);
    const last = page.replies.at(-1);
    if (!page.has_more || last === undefined) return out;
    cursor = last.seq;
  }
}

describe('이력 페이징', () => {
  it('FR-MSG-04 원문·답글 혼합 1만 건을 동시 전송 중 원문 이력을 페이지로 넘기면 누락·중복 0이고 답글은 페이지 크기를 쓰지 않으며 답글 이력은 스레드별로 같고 seq 간격을 유실로 보지 않는다', async () => {
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'general');
    const b = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    for (const member of [b, c]) await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, member);
    const sessions: Session[] = [];
    for (const user of ['a', 'b', 'c']) for (let i = 0; i < SESSIONS_PER_USER; i += 1) sessions.push(await as(ctx.app, user));

    const preRoots: MessageView[] = [];
    for (let i = 0; i < PRE_ROOTS; i += 1) preRoots.push(await send(ctx.app, a, channel, { body: `pre-${i}` }));

    // 동시 전송: 짝수 번째는 원문, 홀수 번째는 사전 원문에 고르게 퍼진 답글.
    const sent: MessageView[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < TOTAL_SENDS) {
        const i = next;
        next += 1;
        const session = sessions[i % sessions.length] as Session;
        const target = i % 2 === 1 ? (preRoots[(i >> 1) % PRE_ROOTS] as MessageView).id : null;
        sent.push(await send(ctx.app, session, channel, { body: `m-${i}`, thread_root_id: target }));
      }
    };

    // 역방향 페이징: 일부 커밋 뒤 최신 페이지부터 before_seq로 처음까지.
    const backward: MessageView[] = [];
    let maxSeen = 0;
    let sentAtLastPage = 0;
    const pageBackward = async (): Promise<void> => {
      while (sent.length < PAGING_START_AFTER) await new Promise((r) => setTimeout(r, 5));
      let page: Page = await history(ctx.app, a, channel, `?limit=${HISTORY_LIMIT_MAX}`);
      maxSeen = page.messages.at(-1)?.seq ?? 0;
      for (;;) {
        checkHistoryPage(page);
        backward.push(...page.messages);
        sentAtLastPage = sent.length;
        const first = page.messages[0];
        if (!page.has_more || first === undefined) return;
        page = await history(ctx.app, a, channel, pageQuery(`before_seq=${first.seq}`));
      }
    };

    const started = performance.now();
    const sendPhase = Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => performance.now() - started);
    const [sendMs] = await Promise.all([sendPhase, pageBackward()]);
    console.log(`FR-MSG-04 send phase ms=${Math.round(sendMs)} sends=${TOTAL_SENDS} concurrency=${CONCURRENCY}`);
    expect(sent).toHaveLength(TOTAL_SENDS);
    // 역방향 페이징 전체가 전송 도중에 끝났다(마지막 페이지 시점에도 전송이 남아 있었다).
    expect(sentAtLastPage).toBeLessThan(TOTAL_SENDS);

    // 전송 종료 후 역방향에서 본 최대 seq 이후를 after_seq 정방향으로 모은다.
    const forward: MessageView[] = [];
    let cursor = maxSeen;
    for (;;) {
      const page = await history(ctx.app, b, channel, pageQuery(`after_seq=${cursor}`));
      checkHistoryPage(page);
      forward.push(...page.messages);
      const last = page.messages.at(-1);
      if (!page.has_more || last === undefined) break;
      cursor = last.seq;
    }

    // 누락·중복 0: 보낸 원문 전체(사전+동시)가 합집합에 정확히 한 번씩.
    const sentRoots = [...preRoots, ...sent.filter((m) => m.thread_root_id === null)];
    const sentReplies = sent.filter((m) => m.thread_root_id !== null);
    expect(sentRoots).toHaveLength(PRE_ROOTS + TOTAL_SENDS / 2);
    const seen = [...backward, ...forward].map((m) => m.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(sentRoots.map((m) => m.id)));
    const replyIds = new Set(sentReplies.map((m) => m.id));
    expect(seen.filter((id) => replyIds.has(id))).toEqual([]);

    // 원문 seq에는 답글이 차지한 간격이 있다. 이것은 유실이 아니다(위에서 누락 0을 이미 단언).
    const rootSeqs = [...backward, ...forward].map((m) => m.seq).sort((x, y) => x - y);
    const gaps = rootSeqs.slice(1).filter((s, k) => s - (rootSeqs[k] as number) > 1);
    expect(gaps.length).toBeGreaterThan(0);
    expect(rootSeqs.at(-1)).toBe(Math.max(...sentRoots.map((m) => m.seq)));
    // 대화 seq는 원문·답글을 합쳐 1..N으로 빈틈없이 쓰였다(간격은 전부 답글 몫).
    expect(Math.max(...[...preRoots, ...sent].map((m) => m.seq))).toBe(PRE_ROOTS + TOTAL_SENDS);

    // 답글 이력: 스레드별로 보낸 답글 집합과 정확히 같고, seq 오름차순, 두 번 읽어도 같다.
    for (const root of preRoots) {
      const expected = sentReplies.filter((m) => m.thread_root_id === root.id).map((m) => m.id);
      const first = await allReplies(a, root.id);
      const second = await allReplies(c, root.id);
      expect(new Set(first.map((m) => m.id))).toEqual(new Set(expected));
      expect(first).toHaveLength(expected.length);
      const seqs = first.map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
    }
  }, 180_000);
});
