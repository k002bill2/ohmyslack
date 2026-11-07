import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_ACTIONS } from '../../src/http/access.js';
import type { Session } from '../auth/members-int-harness.js';
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
}

async function fixture(): Promise<Fixture> {
  const a = await as(ctx.app, 'a');
  const dm = (await req(ctx.app, 'POST', '/api/dms', a, { user_id: ctx.ids.b })).json<{ id: string }>().id;
  const channel = await createChannel(ctx.app, a, 'matrix');
  const l = await as(ctx.app, 'l');
  await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, l);
  await req(ctx.app, 'POST', `/api/conversations/${dm}/join`, l);
  expect((await req(ctx.app, 'DELETE', `/api/conversations/${channel}/membership`, l)).statusCode).toBe(204);
  const c = await as(ctx.app, 'c');
  const d = await as(ctx.app, 'd');
  await req(ctx.app, 'POST', `/api/conversations/${channel}/join`, d);
  await ctx.schema.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ctx.ids.d]);
  return { dm, channel, c, l, d };
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
    const scoped = routes.filter((r) => r.access === 'conversation' || r.access === 'message');
    expect(scoped.length).toBeGreaterThan(0);
    expect(WS_ACTIONS).toEqual([{ action: 'conversation.subscribe', access: 'conversation' }]); // W-09b WS 행.
    const before = await convState(ctx.schema);
    const ended = ctx.ended.length;
    for (const route of scoped) {
      expect(route.url, `${route.method} ${route.url}: 대화 경로 변수 없음`).toContain(':id');
      const label = `${route.method} ${route.url}`;
      // 비참여자 C → DM: 404, 응답에 DM ID 없음.
      const cDm = await hit(route.method, route.url.replace(':id', fx.dm), fx.c);
      expect(cDm.status, `C ${label}`).toBe(404);
      expect(cDm.text).not.toContain(ctx.ids.b);
      // 나간 사용자 L → 채널: join(재참여 허용 대상)만 예외, 나머지 404.
      if (!route.url.endsWith('/join')) expect((await hit(route.method, route.url.replace(':id', fx.channel), fx.l)).status, `L ${label}`).toBe(404);
      // 비활성 D → 채널: 401.
      expect((await hit(route.method, route.url.replace(':id', fx.channel), fx.d)).status, `D ${label}`).toBe(401);
    }
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
