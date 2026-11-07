import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { login } from '../support/auth-app.js';
import { setupAuthInt, teardownAuthInt, type AuthIntContext } from './auth-int-harness.js';

/** 정본: DEV_DESIGN 6-3 TR-SEC-11, TRD §5-1 S8, THREAT_MODEL NC-08. */
const SECRET = 'cookie-attrs-secret-0001';
const EMAIL = 'cookie@example.test';
let ctx: AuthIntContext | undefined;

beforeEach(async () => {
  ctx = await setupAuthInt(EMAIL, SECRET);
});

afterEach(async () => {
  await teardownAuthInt(ctx);
  ctx = undefined;
});

describe('TR-SEC-11 session cookie', () => {
  it('TR-SEC-11 세션 쿠키는 HttpOnly·Secure·SameSite=Lax·Path=/이고 Domain 속성이 없으며 운영 설정에서 Secure를 끌 수 없다', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await login((ctx as AuthIntContext).app, EMAIL, SECRET);
      expect(res.statusCode).toBe(200);
      const raw = String(res.headers['set-cookie']);
      expect(raw.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      const attrs = raw.split(';').map((part) => part.trim().toLowerCase());
      expect(attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/', 'max-age=7776000']));
      expect(attrs.some((a) => a.startsWith('domain'))).toBe(false);
      expect(() => buildApp({ cookieSecure: false } as never)).toThrow(/알 수 없는 앱 옵션/);
      expect(() => buildApp({ secure: false } as never)).toThrow(/알 수 없는 앱 옵션/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
