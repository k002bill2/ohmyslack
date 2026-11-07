import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindGuardError, listenLoopback, resolveListenHost } from '../../src/bind.js';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { addUser, signIn } from '../auth/members-int-harness.js';
import { migratedSchema } from '../auth/bootstrap-harness.js';
import { HOST, testApp } from '../support/auth-app.js';
import type { TestSchema } from '../support/test-db.js';

/** FR-OPS-01 노출 경계(TRD §6, NC-05): 기본 바인드 127.0.0.1, 루프백 외 설정은 기동 거부, tailnet 접근이어도 로그인 필요. */
let schema: TestSchema | undefined;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await schema?.drop();
  schema = undefined;
});

/** Tailscale Serve가 붙이는 신원·전달 헤더를 흉내 낸 요청. 앱은 이 헤더를 신뢰하지 않아야 한다(NC-06). */
const TAILNET_HEADERS = Object.freeze({
  'tailscale-user-login': 'owner@example.test',
  'tailscale-user-name': 'Owner',
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-proto': 'https',
});

function getStatus(port: number, path: string, headers: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: HOST, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const REJECTED_HOSTS = ['0.0.0.0', '::', '::1', '192.168.0.10', '10.0.0.5', '172.16.1.2', '100.101.102.103', 'fd7a:115c:a1e0::1', 'localhost', '127.0.0.2'];

describe('FR-OPS-01 바인드·노출 경계', () => {
  it('FR-OPS-01 서버 기본 바인드 주소는 127.0.0.1이고 tailnet 접근만으로 로그인이 생략되지 않는다', async () => {
    // 1) 설정 누락·빈 값 → 기본값 127.0.0.1
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ HOST: '' })).toBe('127.0.0.1');
    expect(resolveListenHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
    // 2) 와일드카드·IPv6·LAN·tailnet IP·이름 해석 주소는 기동 거부
    for (const host of REJECTED_HOSTS) expect(() => resolveListenHost({ HOST: host }), host).toThrow(BindGuardError);

    // 3) 거부된 설정은 listen 자체를 호출하지 않는다(리스너를 열기 전에 검사).
    const refused = testApp({});
    apps.push(refused);
    const listenSpy = vi.spyOn(refused, 'listen');
    await expect(listenLoopback(refused, { HOST: '0.0.0.0' }, 0)).rejects.toThrow(BindGuardError);
    expect(listenSpy).not.toHaveBeenCalled();
    expect(refused.server.listening).toBe(false);

    // 4) HOST 미설정으로 실제 기동 → 리스너 주소는 127.0.0.1 하나.
    schema = await migratedSchema();
    await addUser(schema, 'owner@example.test', 'owner');
    const app = testApp({ authStore: createPgAuthStore(schema.pool) });
    apps.push(app);
    const address = await listenLoopback(app, {}, 0);
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');

    // 5) tailnet(Serve) 경유 요청이어도 세션 쿠키 없이는 401, 위조 쿠키도 401.
    expect(await getStatus(address.port, '/api/me', TAILNET_HEADERS)).toBe(401);
    expect(await getStatus(address.port, '/api/me', { ...TAILNET_HEADERS, cookie: `${SESSION_COOKIE}=forged-session-value` })).toBe(401);
    // 대조군: 실제 로그인 세션은 같은 리스너에서 200 → 401이 "모든 요청 거부"가 아님을 보인다.
    const session = await signIn(app, 'owner@example.test');
    expect(await getStatus(address.port, '/api/me', { ...TAILNET_HEADERS, cookie: `${SESSION_COOKIE}=${session.token}` })).toBe(200);
  });
});
