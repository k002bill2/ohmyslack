import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messagePreviewResponseSchema } from '../../src/shared.js';
import { as, createChannel, req, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { send } from './msg-int-harness.js';

let ctx: ConvIntContext;

beforeEach(async () => {
  ctx = await setupConvInt();
});

afterEach(async () => {
  await teardownConvInt(ctx);
});

const previewUrl = (id: string): string => `/api/messages/${id}/preview`;
const repliesUrl = (id: string): string => `/api/messages/${id}/replies`;

/** FR-CLIENT-05(TRD §6-2): payload는 식별자만, 알림 본문은 SW가 로그인 세션으로 이 라우트에서 가져온다. 접근 판정은 replies와 같은 messageGuard. */
describe('FR-CLIENT-05 알림 미리보기 조회 라우트', () => {
  it('멤버는 200 + 평문 미리보기(no-store), 삭제·평문 없음은 text:null, 비멤버·나간 멤버·비활성 계정은 replies와 같은 거부, 미인증 401', async () => {
    const a = await as(ctx.app, 'a');
    const b = await as(ctx.app, 'b');
    const c = await as(ctx.app, 'c');
    const l = await as(ctx.app, 'l');
    const general = await createChannel(ctx.app, a, 'general');
    for (const who of [b, l]) expect((await req(ctx.app, 'POST', `/api/conversations/${general}/join`, who)).statusCode).toBeLessThan(300);
    const msg = await send(ctx.app, a, general, { body: '**안녕** [문서](https://example.test/x)\n> 인용' });

    const ok = await req(ctx.app, 'GET', previewUrl(msg.id), b);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(messagePreviewResponseSchema.parse(ok.json())).toEqual({ text: '안녕 문서 인용' });

    const markupOnly = await send(ctx.app, a, general, { body: '**  **' });
    expect((await req(ctx.app, 'GET', previewUrl(markupOnly.id), b)).json()).toEqual({ text: null });

    const gone = await send(ctx.app, a, general, { body: '곧 지울 비밀 본문' });
    expect((await req(ctx.app, 'DELETE', `/api/messages/${gone.id}`, a)).statusCode).toBe(200);
    const deleted = await req(ctx.app, 'GET', previewUrl(gone.id), b);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ text: null });
    expect(deleted.body).not.toContain('비밀 본문');

    // 비멤버: 기존 가드(replies)와 같은 응답 = 존재 은폐 404.
    const nonMember = await req(ctx.app, 'GET', previewUrl(msg.id), c);
    expect(nonMember.statusCode).toBe(404);
    expect(nonMember.statusCode).toBe((await req(ctx.app, 'GET', repliesUrl(msg.id), c)).statusCode);
    expect(nonMember.body).not.toContain('안녕');

    // 나간 멤버.
    expect((await req(ctx.app, 'DELETE', `/api/conversations/${general}/membership`, b)).statusCode).toBeLessThan(300);
    const left = await req(ctx.app, 'GET', previewUrl(msg.id), b);
    expect(left.statusCode).not.toBe(200);
    expect(left.statusCode).toBe((await req(ctx.app, 'GET', repliesUrl(msg.id), b)).statusCode);

    // 비활성화(탈퇴)된 계정.
    expect((await req(ctx.app, 'POST', `/api/admin/members/${ctx.ids.l}/deactivate`, a)).statusCode).toBeLessThan(300);
    const inactive = await req(ctx.app, 'GET', previewUrl(msg.id), l);
    expect(inactive.statusCode).not.toBe(200);
    expect(inactive.statusCode).toBe((await req(ctx.app, 'GET', repliesUrl(msg.id), l)).statusCode);
    expect(inactive.body).not.toContain('안녕');

    // 미인증·없는 ID.
    expect((await req(ctx.app, 'GET', previewUrl(msg.id))).statusCode).toBe(401);
    expect((await req(ctx.app, 'GET', previewUrl('00000000-0000-4000-8000-000000000000'), a)).statusCode).toBe(404);
    expect((await req(ctx.app, 'GET', '/api/messages/not-a-uuid/preview', a)).statusCode).toBe(404);
  });
});
