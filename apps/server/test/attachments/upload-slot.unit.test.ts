import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { concurrentUploadGuard, registerUploadRoute } from '../../src/modules/attachments/routes.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { csrfTokenFor, type AuthService } from '../../src/modules/auth/service.js';
import { ATTACHMENT_HUMAN_CONCURRENT_UPLOADS } from '../../src/shared.js';

/**
 * 사람 동시 업로드 자리(TRD §6-1-1 (2) ★) — Codex r1 P2: 인증 대기 중 연결이 닫혀도 자리가 새지 않고, 자리는 정확히 1회만 돌아온다.
 * DB 없이 인증만 가짜(지연 제어)로 둔 최소 앱.
 */
const TOKEN = 'session-token';
const MAX = ATTACHMENT_HUMAN_CONCURRENT_UPLOADS;

interface Harness {
  readonly app: FastifyInstance;
  readonly port: number;
  /** 인증 대기 중인 요청 수. */
  readonly pending: () => number;
  /** 대기 중인 인증을 모두 통과시키고, 이후 인증은 즉시 통과. */
  readonly releaseAuth: () => void;
}

let current: FastifyInstance | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function harness(holdAuth: boolean): Promise<Harness> {
  const waiting: (() => void)[] = [];
  let hold = holdAuth;
  const authenticated = { token: TOKEN, user: { id: 'u1', role: 'member' } };
  const auth = {
    authenticate: async () => {
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
      return authenticated;
    },
  } as unknown as AuthService;
  const app = Fastify();
  await app.register(cookie);
  registerUploadRoute(app, '/u', { access: 'account', onRequest: [concurrentUploadGuard(auth)], preHandler: [] }, async (request, reply) => {
    reply.code(201);
    return { bytes: Buffer.isBuffer(request.body) ? request.body.length : 0 };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  current = app;
  return {
    app,
    port: (app.server.address() as AddressInfo).port,
    pending: () => waiting.length,
    releaseAuth: () => {
      hold = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

const headers = (length: number): Record<string, string> => ({
  cookie: `${SESSION_COOKIE}=${TOKEN}`,
  'x-csrf-token': csrfTokenFor(TOKEN),
  'content-type': 'application/octet-stream',
  'content-length': String(length),
});

async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const connections = (app: FastifyInstance): Promise<number> => new Promise((resolve, reject) => app.server.getConnections((e, n) => (e ? reject(e) : resolve(n))));

/** 실소켓으로 헤더만 보내고 body는 보내지 않는 요청. 반환 함수로 클라이언트가 끊는다. */
function abortable(port: number): () => void {
  const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/u', headers: headers(4) });
  req.on('error', () => undefined);
  req.flushHeaders();
  return () => req.destroy();
}

function held(app: FastifyInstance) {
  const body = new PassThrough();
  const response = app.inject({ method: 'POST', url: '/u', headers: headers(4), payload: body });
  let settled = false;
  void response.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { response, finish: () => body.end(Buffer.from('abcd')), isSettled: () => settled };
}

const upload = (app: FastifyInstance): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url: '/u', headers: headers(4), payload: Buffer.from('abcd') });

describe('사람 동시 업로드 자리', () => {
  it('인증 대기 중 클라이언트가 끊으면 자리가 배정되지 않아 같은 계정 업로드 2건이 바로 진행된다', async () => {
    const h = await harness(true);
    const aborts = Array.from({ length: MAX }, () => abortable(h.port));
    await until(() => h.pending() === MAX, '인증 대기');
    for (const abort of aborts) abort();
    await until(async () => (await connections(h.app)) === 0, '서버 쪽 연결 종료');
    h.releaseAuth();
    await new Promise((r) => setTimeout(r, 50));
    const next = await Promise.all(Array.from({ length: MAX }, () => upload(h.app)));
    expect(next.map((r) => r.statusCode)).toEqual(Array.from({ length: MAX }, () => 201));
  });

  it('자리는 정확히 1회만 돌아온다: 하나가 끝나면 한 자리만 비고 그다음 요청은 429', async () => {
    const h = await harness(false);
    const first = Array.from({ length: MAX }, () => held(h.app));
    await until(() => first.every((x) => !x.isSettled()), '자리 점유');
    expect((await upload(h.app)).statusCode).toBe(429);
    const [done, ...rest] = first;
    done?.finish();
    expect((await done?.response)?.statusCode).toBe(201);
    const refill = held(h.app);
    await new Promise((r) => setTimeout(r, 20));
    expect(refill.isSettled()).toBe(false);
    const over = await upload(h.app);
    expect(over.statusCode).toBe(429);
    for (const x of [...rest, refill]) x.finish();
    expect((await Promise.all([...rest, refill].map((x) => x.response))).map((r) => r.statusCode)).toEqual(Array.from({ length: MAX }, () => 201));
    // 모두 끝나면 카운트가 0(음수 아님): 다시 정확히 상한만큼 동시 점유되고 그다음은 429.
    const again = Array.from({ length: MAX }, () => held(h.app));
    await new Promise((r) => setTimeout(r, 20));
    expect(again.every((x) => !x.isSettled())).toBe(true);
    expect((await upload(h.app)).statusCode).toBe(429);
    for (const x of again) x.finish();
    await Promise.all(again.map((x) => x.response));
  });
});
