import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BOT_RATE_LIMITS, BOT_UPLOAD_BYTES_PER_DAY, createBotRateLimiter, type BotRateLimiter, type BotUploadProbe } from '../../src/modules/bots/index.js';
import { as, createChannel, req } from '../conversations/conv-int-harness.js';
import { count, setupBotListener, teardownBotListener, type BotListenerContext } from '../bots/bot-listener-harness.js';
import { png } from './att-harness.js';

/**
 * W-26 Codex r2: 봇 업로드 선행 인증(onRequest)의 빈틈.
 * ① 본문을 기다리는 사이 토큰 폐기·봇 비활성화·채널 제거가 일어나면 본문 수신 뒤 다시 판정해 401·404, 저장 0.
 * ② Content-Length 없는(chunked) 요청도 일일 바이트를 다 쓴 토큰이면 본문을 기다리지 않고 429.
 * W-26 Codex r3: 재판정(settle) 뒤·INSERT 전 회수는 저장 트랜잭션 안 잠금 재확인으로 거부하고, 잠금 뒤 회수는 업로드 커밋을 기다린다.
 * 순서는 sleep이 아니라 업로드 단계 신호(입장·재판정·잠금)로 고정한다.
 */
let lc: BotListenerContext | undefined;

afterEach(async () => {
  await teardownBotListener(lc);
  lc = undefined;
});

const EARLY_MS = 2000;
const LOCK_WAIT_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stored = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM attachments WHERE uploader_id = $1', [ctx.bot.botUserId]);
const blobs = (ctx: BotListenerContext) => count(ctx, 'SELECT count(*)::int AS n FROM attachment_blobs', []);

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type PausePoint = 'recheck' | 'lock';

/** 업로드 단계 신호. `pauseAt`이면 그 지점에 **처음** 도달한 요청을 `release()`까지 멈춘다. 해제는 테스트 finally에서 반드시 한다. */
interface UploadProbe {
  readonly hooks: BotUploadProbe;
  readonly admitted: Promise<void>;
  readonly reached: Promise<void>;
  release(): void;
}

function uploadProbe(pauseAt?: PausePoint): UploadProbe {
  const admitted = deferred();
  const reached = deferred();
  const gate = deferred();
  let paused = false;
  const pause = (point: PausePoint) => async (): Promise<void> => {
    if (point !== pauseAt || paused) return;
    paused = true;
    reached.resolve();
    await gate.promise;
  };
  return {
    hooks: { admitted: () => admitted.resolve(), afterRecheck: pause('recheck'), afterLock: pause('lock') },
    admitted: admitted.promise,
    reached: reached.promise,
    release: () => gate.resolve(),
  };
}

/**
 * 잠금 지점에서 멈춘 업로드 트랜잭션의 backend PID. 이 테스트 스키마의 테이블에 잠금을 쥔 채 `idle in transaction`인 세션이다
 * (DB를 함께 쓰는 다른 테스트·세션은 다른 스키마라 섞이지 않는다 — Codex r4 P3).
 */
async function uploadPid(ctx: BotListenerContext): Promise<number> {
  const res = await ctx.conv.schema.pool.query<{ pid: number }>(
    `SELECT DISTINCT l.pid FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE n.nspname = $1 AND l.granted AND a.state = 'idle in transaction' AND l.pid <> pg_backend_pid()`,
    [ctx.conv.schema.name],
  );
  expect(res.rows, '잠금 지점의 업로드 세션은 정확히 1개').toHaveLength(1);
  return res.rows[0]?.pid ?? -1;
}

/**
 * 업로드 PID가 막고 있는 잠금 대기 세션(회수)이 생기면 'blocked'(`pg_blocking_pids(<회수 PID>)`에 업로드 PID 포함).
 * 회수가 먼저 끝나면 'done'. 둘 다 아니면 'timeout'. 막힌 회수 PID는 `blockedPids`에 남긴다.
 */
async function lockWaitOrDone(ctx: BotListenerContext, upload: number, work: Promise<unknown>, blockedPids: number[] = []): Promise<'blocked' | 'done' | 'timeout'> {
  let settled = false;
  const done = work.then(() => {
    settled = true;
    return 'done' as const;
  });
  const poll = (async () => {
    const until = Date.now() + LOCK_WAIT_MS;
    while (!settled && Date.now() < until) {
      const waiting = await ctx.conv.schema.pool.query<{ pid: number }>(
        'SELECT DISTINCT pid FROM pg_locks WHERE NOT granted AND $1::int = ANY(pg_blocking_pids(pid))',
        [upload],
      );
      if (waiting.rows.length > 0) {
        blockedPids.push(...waiting.rows.map((r) => r.pid));
        return 'blocked' as const;
      }
      await sleep(10);
    }
    return 'timeout' as const;
  })();
  return Promise.race([done, poll]);
}

/** 거부돼도 입장 때 기록한 건수 1·선언 바이트는 되돌리지 않는다(413·415 거부와 같은 규칙). */
function expectUsageKept(limiter: BotRateLimiter, tokenId: string, declaredBytes: number): void {
  expect(limiter.checkUploadBytes(tokenId, BOT_UPLOAD_BYTES_PER_DAY - declaredBytes).ok).toBe(true);
  expect(limiter.checkUploadBytes(tokenId, BOT_UPLOAD_BYTES_PER_DAY - declaredBytes + 1).ok).toBe(false);
  for (let i = 1; i < BOT_RATE_LIMITS.upload; i += 1) expect(limiter.takeUpload(tokenId, 0).ok).toBe(true);
  expect(limiter.takeUpload(tokenId, 0).ok).toBe(false);
}

interface PendingUpload {
  /** 본문을 보내고 응답 상태를 돌려준다. */
  finish(): Promise<number>;
}

function startUpload(ctx: BotListenerContext, conversationId: string, bytes: Buffer, chunked: boolean): { req: ClientRequest; status: Promise<number> } {
  const port = ctx.botPort;
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/api/bot/v1/attachments?conversation_id=${conversationId}`,
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${ctx.token}`,
      'content-type': 'image/png',
      ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(bytes.length) }),
    },
  });
  const status = new Promise<number>((resolve, reject) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
  req.flushHeaders();
  return { req, status };
}

/** 유효한 헤더만 먼저 보내고 입장(onRequest) 통과 신호를 기다린 뒤, 본문은 `finish()` 때 보낸다. */
async function delayedUpload(ctx: BotListenerContext, conversationId: string, admitted: Promise<void>): Promise<PendingUpload> {
  const bytes = png();
  const { req, status } = startUpload(ctx, conversationId, bytes, false);
  await admitted;
  return {
    finish: () => {
      req.end(bytes);
      return status;
    },
  };
}

async function botChannel(ctx: BotListenerContext): Promise<{ channel: string; remove: () => Promise<number> }> {
  const app = ctx.conv.app;
  const owner = await as(app, 'a');
  const channel = await createChannel(app, owner, 'upload-room');
  expect((await req(app, 'POST', `/api/conversations/${channel}/bots`, owner, { bot_user_id: ctx.bot.botUserId })).statusCode).toBe(201);
  return { channel, remove: async () => (await req(app, 'DELETE', `/api/conversations/${channel}/bots/${ctx.bot.botUserId}`, owner)).statusCode };
}

/** 고정 시계 limiter + 업로드 신호로 리스너를 띄운다(사용량 단언용). */
async function setupProbed(pauseAt?: PausePoint): Promise<{ ctx: BotListenerContext; probe: UploadProbe; limiter: BotRateLimiter }> {
  const limiter = createBotRateLimiter(() => 0);
  const probe = uploadProbe(pauseAt);
  const ctx = await setupBotListener({ limiter, uploadProbe: probe.hooks });
  return { ctx, probe, limiter };
}

describe('봇 업로드 — 본문 수신 뒤 권한 재판정', () => {
  it('본문 대기 중 토큰을 폐기하면 본문 완료 시 401이고 저장 0', async () => {
    const { ctx, probe, limiter } = await setupProbed();
    lc = ctx;
    const pending = await delayedUpload(lc, lc.bot.dmConversationId, probe.admitted);
    expect((await lc.service.revokeToken(lc.tokenId)).revoked).toBe(true);
    expect(await pending.finish()).toBe(401);
    expect(await stored(lc)).toBe(0);
    expectUsageKept(limiter, lc.tokenId, png().length);
  });

  it('본문 대기 중 봇을 비활성화하면 본문 완료 시 401이고 저장 0', async () => {
    const { ctx, probe, limiter } = await setupProbed();
    lc = ctx;
    const pending = await delayedUpload(lc, lc.bot.dmConversationId, probe.admitted);
    await lc.service.disableBot(lc.bot.botUserId);
    expect(await pending.finish()).toBe(401);
    expect(await stored(lc)).toBe(0);
    expectUsageKept(limiter, lc.tokenId, png().length);
  });

  it('본문 대기 중 채널에서 봇을 제거하면 본문 완료 시 404이고 저장 0', async () => {
    const { ctx, probe, limiter } = await setupProbed();
    lc = ctx;
    const room = await botChannel(lc);
    const pending = await delayedUpload(lc, room.channel, probe.admitted);
    expect(await room.remove()).toBe(204);
    expect(await pending.finish()).toBe(404);
    expect(await stored(lc)).toBe(0);
    expectUsageKept(limiter, lc.tokenId, png().length);
  });

  it('권한이 그대로면 지연된 본문도 201로 저장된다(회귀)', async () => {
    const { ctx, probe } = await setupProbed();
    lc = ctx;
    const room = await botChannel(lc);
    const pending = await delayedUpload(lc, room.channel, probe.admitted);
    expect(await pending.finish()).toBe(201);
    expect(await stored(lc)).toBe(1);
  });
});

interface Revocation {
  readonly name: string;
  readonly status: 401 | 404;
  /** 회수 실행. 반환 promise는 회수 커밋 뒤 끝난다. */
  revoke(ctx: BotListenerContext, room: { remove: () => Promise<number> }): Promise<void>;
}

const REVOCATIONS: readonly Revocation[] = [
  {
    name: '토큰 폐기',
    status: 401,
    revoke: async (ctx) => {
      expect((await ctx.service.revokeToken(ctx.tokenId)).revoked).toBe(true);
    },
  },
  {
    name: '봇 비활성화',
    status: 401,
    revoke: async (ctx) => {
      expect((await ctx.service.disableBot(ctx.bot.botUserId)).revokedTokenIds).toEqual([ctx.tokenId]);
    },
  },
  {
    name: '채널에서 봇 제거',
    status: 404,
    revoke: async (_ctx, room) => {
      expect(await room.remove()).toBe(204);
    },
  },
];

describe('봇 업로드 — 재판정 뒤·INSERT 전 권한 회수 경쟁(저장 트랜잭션 안 잠금)', () => {
  for (const r of REVOCATIONS) {
    it(`재판정 완료 뒤 ${r.name}가 커밋되면 ${r.status}이고 메타·바이트 저장 0, 사용량은 유지`, async () => {
      const { ctx, probe, limiter } = await setupProbed('recheck');
      lc = ctx;
      const room = await botChannel(lc);
      const bytes = png();
      const { req, status } = startUpload(lc, room.channel, bytes, false);
      req.end(bytes);
      try {
        await probe.reached;
        await r.revoke(lc, room);
      } finally {
        probe.release();
      }
      expect(await status).toBe(r.status);
      expect(await stored(lc)).toBe(0);
      expect(await blobs(lc)).toBe(0);
      expectUsageKept(limiter, lc.tokenId, bytes.length);
    });

    it(`잠금 획득 뒤 들어온 ${r.name}는 업로드 커밋까지 기다리고, 업로드 201 뒤에 적용된다`, async () => {
      const { ctx, probe } = await setupProbed('lock');
      lc = ctx;
      const room = await botChannel(lc);
      const bytes = png();
      const { req, status } = startUpload(lc, room.channel, bytes, false);
      req.end(bytes);
      let revoking: Promise<void> | undefined;
      try {
        await probe.reached;
        const upload = await uploadPid(lc);
        revoking = r.revoke(lc, room);
        const blocked: number[] = [];
        expect(await lockWaitOrDone(lc, upload, revoking, blocked)).toBe('blocked');
        expect(blocked.length).toBeGreaterThan(0);
        expect(blocked).not.toContain(upload);
        expect(await stored(lc)).toBe(0); // 아직 커밋 전
      } finally {
        probe.release();
      }
      expect(await status).toBe(201);
      await revoking;
      expect(await stored(lc)).toBe(1);
      expect(await blobs(lc)).toBe(1);
      // 회수는 업로드 커밋 뒤에 적용됐다: 같은 토큰의 다음 업로드는 거부.
      const after = startUpload(lc, room.channel, bytes, false);
      after.req.end(bytes);
      expect(await after.status).toBe(r.status);
      expect(await stored(lc)).toBe(1);
    });
  }
});

describe('봇 업로드 — chunked 요청의 일일 바이트 선행 판정', () => {
  it('일일 100 MiB를 다 쓰고 분당 창은 빈 토큰이 chunked 헤더만 보내면 본문 대기 없이 429', async () => {
    let now = 0;
    const limiter = createBotRateLimiter(() => now);
    lc = await setupBotListener({ limiter });
    expect(limiter.takeUploadBytes(lc.tokenId, BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    now += 61_000; // 분당 건수 창은 비어 있다(바이트는 24시간 창).
    const { req, status } = startUpload(lc, lc.bot.dmConversationId, Buffer.alloc(0), true);
    const early = await Promise.race([status, sleep(EARLY_MS).then(() => 'timeout' as const)]);
    req.destroy();
    expect(early).toBe(429);
    expect(await stored(lc)).toBe(0);
  });

  it('일일 잔여가 있으면 chunked 업로드는 받은 바이트로 집계해 201(회귀)', async () => {
    let now = 0;
    const limiter = createBotRateLimiter(() => now);
    lc = await setupBotListener({ limiter });
    const bytes = png();
    expect(limiter.takeUploadBytes(lc.tokenId, BOT_UPLOAD_BYTES_PER_DAY - bytes.length).ok).toBe(true);
    now += 61_000;
    const { req, status } = startUpload(lc, lc.bot.dmConversationId, bytes, true);
    req.end(bytes);
    expect(await status).toBe(201);
    expect(await stored(lc)).toBe(1);
    // 받은 바이트로 집계됐으므로 남은 일일 바이트는 0이다.
    expect(limiter.takeUploadBytes(lc.tokenId, 1).ok).toBe(false);
  });
});
