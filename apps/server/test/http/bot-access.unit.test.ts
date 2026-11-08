import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_KINDS,
  AccessMetaError,
  markAccountGuard,
  markBotGuard,
  markConversationGuard,
  registerAccessRegistry,
} from '../../src/http/access.js';

/** access 메타 `bot`(DEV_DESIGN §2-4 R3.3, B9, TRD §5-2 3항). 실제 봇 라우트·가드는 봇 리스너 레인(W-18b). */
const plain = async (): Promise<void> => undefined;

describe('access 메타 bot과 리스너 분리(B9)', () => {
  it('ACCESS_KINDS에 bot과 attachment(W-21)가 있다', () => {
    expect(ACCESS_KINDS).toContain('bot');
    expect(ACCESS_KINDS).toContain('attachment');
  });

  it('attachment 메타는 assertAccess 가드 표식이 있어야 메인 리스너에 등록되고 봇 리스너에는 등록되지 않는다(B2·B9)', () => {
    const app = Fastify();
    const routes = registerAccessRegistry(app);
    expect(() => app.get('/api/attachments/:id', { config: { access: 'attachment' }, preHandler: plain }, async () => 'x')).toThrow(/대화 접근 가드 누락/);
    const guard = markConversationGuard(async (): Promise<void> => undefined);
    app.get('/api/attachments/:id', { config: { access: 'attachment' }, preHandler: guard }, async () => 'y');
    expect(routes.map((r) => `${r.method} ${r.access}`)).toContain('GET attachment');
    const bot = Fastify();
    registerAccessRegistry(bot, { listener: 'bot' });
    expect(() => bot.get('/api/bot/v1/attachments/:id', { config: { access: 'attachment' }, preHandler: guard }, async () => 'z')).toThrow(AccessMetaError);
  });

  it('메인 리스너(기본값)에 bot 메타 라우트를 등록하면 봇 가드 표식이 있어도 거부된다', () => {
    const app = Fastify();
    const routes = registerAccessRegistry(app);
    const guard = markBotGuard(async (): Promise<void> => undefined);
    expect(() => app.get('/api/bot/v1/me', { config: { access: 'bot' }, preHandler: guard }, async () => 'x')).toThrow(
      AccessMetaError,
    );
    expect(() => app.get('/api/x', { config: { access: 'bot' }, preHandler: guard }, async () => 'y')).toThrow(/메인 리스너/);
    expect(routes).toEqual([]);
  });

  it('봇 리스너는 표식 없는 bot 라우트를 거부하고 markBotGuard가 있는 /api/bot/v1/** 만 등록한다', () => {
    const app = Fastify();
    const routes = registerAccessRegistry(app, { listener: 'bot' });
    const guard = markBotGuard(async (): Promise<void> => undefined);
    expect(() => app.get('/api/bot/v1/a', { config: { access: 'bot' }, preHandler: plain }, async () => 'a')).toThrow(/봇 가드 누락/);
    expect(() => app.get('/api/bot/v1/b', { config: { access: 'bot' } }, async () => 'b')).toThrow(AccessMetaError);
    expect(() => app.get('/api/me', { config: { access: 'bot' }, preHandler: guard }, async () => 'c')).toThrow(/봇 리스너/);
    const account = markAccountGuard(async (): Promise<void> => undefined);
    expect(() => app.get('/api/bot/v1/d', { config: { access: 'account' }, preHandler: account }, async () => 'd')).toThrow(
      /봇 리스너/,
    );
    expect(() => app.get('/api/bot/v1/me', { config: { access: 'bot' }, preHandler: [plain, guard] }, async () => 'ok')).not.toThrow();
    expect(routes.map((r) => `${r.method} ${r.url} ${r.access}`)).toEqual([
      'GET /api/bot/v1/me bot',
      'HEAD /api/bot/v1/me bot',
    ]);
  });
});
