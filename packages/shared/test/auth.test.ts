import { describe, expect, it } from 'vitest';
import { errorResponseSchema, loginRequestSchema, meResponseSchema } from '../src/index.js';

const SECRET = ['x'].join('');

describe('auth schemas', () => {
  it('login request accepts email+password and rejects extra or oversized fields', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: SECRET }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: SECRET, user_id: 'u' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: SECRET.repeat(1025) }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: '', password: SECRET }).success).toBe(false);
  });

  it('me response requires csrf_token and a known role', () => {
    const user = { id: '00000000-0000-4000-8000-000000000000', email: 'a@b.test', display_name: 'A', role: 'owner' };
    expect(meResponseSchema.safeParse({ user, csrf_token: 't' }).success).toBe(true);
    expect(meResponseSchema.safeParse({ user: { ...user, role: 'admin' }, csrf_token: 't' }).success).toBe(false);
  });

  it('error response carries only code and request_id', () => {
    expect(errorResponseSchema.safeParse({ error: { code: 'x', request_id: 'r' } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { code: 'x', request_id: 'r', stack: 's' } }).success).toBe(false);
  });
});
