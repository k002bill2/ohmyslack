import type pg from 'pg';
import { hashPassword, normalizeEmail } from '../../src/modules/auth/password.js';
import { CliRefusal, inTransaction, parseOptions, readPolicyPassword, runCommand, type CliIo } from './cli.js';

/** 로컬 자격 증명 복구(정본: TRD §5-1 S4). 같은 트랜잭션에서 해시 교체 + 그 계정 세션 전부 revoke. */
export interface ResetPasswordHooks {
  /**
   * COMMIT 뒤 호출되는 세션 revoke 이벤트 훅 자리. 열린 WS를 5초 안에 닫는 일은 W-09(realtime) 범위이며,
   * 이 명령은 별도 프로세스라 W-09가 DB 기반 신호(예: NOTIFY)로 연결해야 한다.
   */
  readonly onSessionsRevoked?: (userId: string, revokedCount: number) => void | Promise<void>;
}

export interface ResetPasswordResult {
  readonly userId: string;
  readonly revokedCount: number;
}

const USAGE = '사용법: reset-password --email <이메일> (비밀번호는 TTY 또는 stdin)';

export async function resetPassword(
  pool: pg.Pool,
  input: { readonly email: string; readonly password: string },
  hooks: ResetPasswordHooks = {},
): Promise<ResetPasswordResult> {
  const emailNorm = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const result = await inTransaction(pool, async (client) => {
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE email_norm = $1 FOR UPDATE', [emailNorm]);
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new CliRefusal('no_such_user', '해당 이메일 계정이 없습니다');
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
    const revoked = await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return { userId, revokedCount: revoked.rowCount ?? 0 };
  });
  await hooks.onSessionsRevoked?.(result.userId, result.revokedCount);
  return result;
}

/** CLI 진입: 인자 검사 → 비노출 비밀번호 입력 → resetPassword. 반환값은 종료 코드. */
export function runResetPassword(
  argv: readonly string[],
  io: CliIo,
  pool: pg.Pool,
  hooks: ResetPasswordHooks = {},
): Promise<number> {
  return runCommand(io, 'reset-password', async () => {
    const options = parseOptions(argv, ['email']);
    if (options?.email === undefined) throw new CliRefusal('usage', USAGE);
    const password = await readPolicyPassword(io);
    const result = await resetPassword(pool, { email: options.email, password }, hooks);
    return `비밀번호를 바꾸고 세션 ${result.revokedCount}개를 폐기했습니다`;
  });
}
