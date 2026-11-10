import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_ACTIONS } from '../../src/http/access.js';
import { png, upload, uploadedId } from '../attachments/att-harness.js';
import type { Session } from '../auth/members-int-harness.js';
import { bot as botCall, botUpload, setupBotListener, teardownBotListener } from '../bots/bot-listener-harness.js';
import { as, convState, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext, type Method } from './conv-int-harness.js';

/**
 * 접근 매트릭스(DEV_DESIGN §2-4, B2). 대상은 하드코딩하지 않고 앱 레지스트리에 실제 등록된 **전체** 라우트다.
 * 행위자: 비참여자 C, 나간 사용자 L, 비활성 계정 D. 기대값은 TRD:105(비멤버 404·비활성 401).
 */
let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

interface Fixture {
  readonly dm: string;
  readonly channel: string;
  readonly c: Session;
  readonly l: Session;
  readonly d: Session;
  /** A가 올린 첨부(대화별). `attachment` 메타 라우트의 `:id` 대상(W-21). */
  readonly files: Readonly<Record<string, string>>;
}

async function fixture(): Promise<Fixture> {
  const a = await as(ctx.app, 'a');
  const dm = (await req(ctx.app, 'POST', '/api/dms', a, { user_id: ctx.ids.b })).json<{ id: string }>().id;
  const channel = await createChannel(ctx.app, a, 'matrix');
  const files = { [dm]: await uploadedId(ctx.app, a, dm, png(), 'image/png'), [channel]: await uploadedId(ctx.app, a, channel, png(), 'image/png') };
  const l = await as(ctx.app, 'l');
  await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, l);
  await req(ctx.app, 'POST', `/api/conversations/${dm}/join`, l);
  expect((await req(ctx.app, 'DELETE', `/api/conversations/${channel}/membership`, l)).statusCode).toBe(204);
  const c = await as(ctx.app, 'c');
  const d = await as(ctx.app, 'd');
  await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, d);
  await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
  return { dm, channel, c, l, d, files };
}

const BODY = { kind: 'channel', name: 'x', user_id: '00000000-0000-4000-8000-000000000000', body: 'x' };
const withBody = (method: string): boolean => method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';

async function hit(method: string, url: string, session: Session): Promise<{ status: number; text: string }> {
  const res = await req(ctx.app, method as Method, url, session, withBody(method) ? BODY : undefined);
  return { status: res.statusCode, text: res.body };
}

describe('접근 매트릭스', () => {
  it('FR-CONV-04 접근 레지스트리의 모든 HTTP 라우트와 WS 동작에서 비참여자·나간 사용자는 내용·멤버십·이벤트 0건이고 데이터가 바뀌지 않으며 공개 채널 discover만 메시지·멤버 정보 없이 예외다', async () => {
    const fx = await fixture();
    const routes = ctx.app.accessRoutes;
    const scoped = routes.filter((r) => r.access === 'conversation' || r.access === 'message' || r.access === 'attachment');
    expect(scoped.some((r) => r.access === 'attachment')).toBe(true); // W-21 attachment 메타 행.
    // attachment 메타는 `:id`가 첨부 ID다(첨부 → 대화 해석 → assertAccess).
    const target = (route: { readonly access: string }, conv: string): string => (route.access === 'attachment' ? (fx.files[conv] ?? '') : conv);
    expect(scoped.length).toBeGreaterThan(0);
    expect(WS_ACTIONS).toEqual([{ action: 'conversation.subscribe', access: 'conversation' }]); // W-09b WS 행.
    const before = await convState(ctx.schema);
    const ended = ctx.ended.length;
    for (const route of scoped) {
      expect(route.url, `${route.method} ${route.url}: 대화 경로 변수 없음`).toContain(':id');
      const label = `${route.method} ${route.url}`;
      // 비참여자 C → DM: 404, 응답에 DM ID 없음.
      const cDm = await hit(route.method, route.url.replace(':id', target(route, fx.dm)), fx.c);
      expect(cDm.status, `C ${label}`).toBe(404);
      expect(cDm.text).not.toContain(ctx.ids.b);
      // 나간 사용자 L → 채널: join(재참여 허용 대상)만 예외, 나머지 404.
      if (!route.url.endsWith('/join')) expect((await hit(route.method, route.url.replace(':id', target(route, fx.channel)), fx.l)).status, `L ${label}`).toBe(404);
      // 비활성 D → 채널: 401.
      expect((await hit(route.method, route.url.replace(':id', target(route, fx.channel)), fx.d)).status, `D ${label}`).toBe(401);
    }
    // 업로드(`account` 메타 + assertAccess(write) 가드, 경로 변수 없음): C → DM 404, L → 채널 404, D → 401. 저장 0.
    const stored = (await ctx.schema.pool.query('SELECT id FROM attachments')).rowCount;
    expect((await upload(ctx.app, fx.c, fx.dm, png(), 'image/png')).statusCode).toBe(404);
    expect((await upload(ctx.app, fx.l, fx.channel, png(), 'image/png')).statusCode).toBe(404);
    expect((await upload(ctx.app, fx.d, fx.channel, png(), 'image/png')).statusCode).toBe(401);
    expect((await ctx.schema.pool.query('SELECT id FROM attachments')).rowCount).toBe(stored);
    // account·public GET 응답에는 C·L이 참여하지 않은 DM이 0건.
    for (const route of routes.filter((r) => r.method === 'GET' && (r.access === 'account' || r.access === 'public'))) {
      for (const who of [fx.c, fx.l]) {
        const res = await hit('GET', route.url, who);
        expect(res.text, `${route.url}`).not.toContain(fx.dm);
      }
    }
    // discover 예외: L은 나간 채널을 이름·ID로만 본다(메시지·멤버 정보 없음).
    const disc = (await req(ctx.app, 'GET', '/api/conversations/discover', fx.l)).json<{ channels: Record<string, unknown>[] }>();
    expect(disc.channels).toEqual([{ id: fx.channel, name: 'matrix' }]);
    expect(await convState(ctx.schema)).toEqual(before);
    expect(ctx.ended.length).toBe(ended);
  });
});

describe('접근 매트릭스 — 봇 행위자(TRD §5-2 5항)', () => {
  it('봇 리스너의 모든 등록 라우트에서 봇은 참여하지 않은 대화·메시지에 404이고 대화 데이터가 바뀌지 않는다', async () => {
    const lc = await setupBotListener();
    try {
      const owner = await as(lc.conv.app, 'a');
      const channel = await createChannel(lc.conv.app, owner, 'bot-matrix');
      const root = (await req(lc.conv.app, 'POST', `/api/conversations/${channel}/messages`, owner, {
        client_message_id: '00000000-0000-4000-8000-0000000000aa',
        body: 'x',
      })).json<{ message: { id: string } }>().message.id;
      const before = await convState(lc.conv.schema);
      const routes = (lc.botApp.botAccessRoutes ?? []).filter((r) => r.method !== 'HEAD');
      const file = await uploadedId(lc.conv.app, owner, channel, png(), 'image/png');
      const scoped = routes.filter((r) => r.url.includes(':id') || r.url.endsWith('/snapshot') || r.url.endsWith('/read-state'));
      // W-21: GET attachments/:id 추가로 6 → 7.
      expect(scoped.length).toBe(7);
      for (const route of scoped) {
        const target = route.url.includes('/messages/:id') ? root : route.url.includes('/attachments/:id') ? file : channel;
        let path = route.url.replace('/api/bot/v1/', '').replace(':id', target);
        if (path === 'sync/snapshot') path = `sync/snapshot?conversation_id=${channel}`;
        const body = route.method === 'GET' ? undefined : { ...BODY, client_message_id: '00000000-0000-4000-8000-0000000000bb', conversation_id: channel, last_read_seq: 1 };
        const cleanBody =
          body === undefined
            ? undefined
            : route.url.endsWith('/read-state')
              ? { conversation_id: channel, last_read_seq: 1 }
              : route.method === 'PATCH'
                ? { body: 'x' }
                : { client_message_id: body.client_message_id, body: 'x' };
        const res = await botCall(lc, route.method, path, cleanBody);
        expect(res.status, `${route.method} ${route.url}`).toBe(404);
      }
      // 봇 업로드(비참여 대화): 404, 저장 0.
      const upBot = (await botUpload(lc, channel, png(), 'image/png')).status;
      expect(upBot).toBe(404);
      expect((await lc.conv.schema.pool.query('SELECT id FROM attachments')).rowCount).toBe(1);
      expect(await convState(lc.conv.schema)).toEqual(before);
    } finally {
      await teardownBotListener(lc);
    }
  });
});

describe('접근 매트릭스 — 봇 채널 참여 라우트(BOT_CHANNEL_SPEC §4-2)', () => {
  it('봇 추가·제거 라우트 2개는 owner만 성공하고 일반 멤버 403·비참여자 404·봇 토큰 경로 없음이다', async () => {
    const lc = await setupBotListener();
    try {
      const app = lc.conv.app;
      const owner = await as(app, 'a');
      const channel = await createChannel(app, owner, 'bot-routes');
      const member = await as(app, 'b');
      await req(app, 'POST', `/api/conversations/${channel}/join`, member);
      const outsider = await as(app, 'c');
      const add = `/api/conversations/${channel}/bots`;
      const remove = `${add}/${lc.bot.botUserId}`;
      const body = { bot_user_id: lc.bot.botUserId };
      const routes = app.accessRoutes.filter((r) => r.url.includes('/bots'));
      expect(routes.map((r) => `${r.method} ${r.url} ${r.access}`).sort()).toEqual([
        'DELETE /api/conversations/:id/bots/:bot_user_id conversation',
        'POST /api/conversations/:id/bots conversation',
      ]);
      for (const [who, status] of [[member, 403], [outsider, 404]] as const) {
        expect((await req(app, 'POST', add, who, body)).statusCode).toBe(status);
        expect((await req(app, 'DELETE', remove, who)).statusCode).toBe(status);
      }
      expect((await botCall(lc, 'POST', `conversations/${channel}/bots`, body)).status).toBe(404);
      expect((await botCall(lc, 'DELETE', `conversations/${channel}/bots/${lc.bot.botUserId}`)).status).toBe(404);
      expect((lc.botApp.botAccessRoutes ?? []).some((r) => r.url.includes('/bots'))).toBe(false);
      expect((await req(app, 'POST', add, owner, body)).statusCode).toBe(201);
      expect((await req(app, 'DELETE', remove, owner)).statusCode).toBe(204);
    } finally {
      await teardownBotListener(lc);
    }
  });
});
