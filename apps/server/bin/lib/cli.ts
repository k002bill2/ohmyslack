import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import type pg from 'pg';
import { checkPasswordPolicy } from '../../src/modules/auth/password.js';
import { readNewSecret, SecretInputError, type SecretInput } from './secret-input.js';

/** 로컬 운영 명령 공통 입출력. 비밀번호·해시·이메일·식별 ID는 어느 스트림에도 쓰지 않는다. */
export interface CliIo {
  readonly stdin: SecretInput;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/** 거부 사유 코드. 메시지는 고정 문구라 입력값을 담지 않는다. */
export class CliRefusal extends Error {
  override readonly name = 'CliRefusal';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** parseArgs 오류 문구는 알 수 없는 인자 값을 되풀이할 수 있어 쓰지 않는다(예: --password <원문>). */
export function parseOptions<K extends string>(
  argv: readonly string[],
  names: readonly K[],
): Partial<Record<K, string>> | undefined {
  const options = Object.fromEntries(names.map((name) => [name, { type: 'string' as const }]));
  try {
    const { values } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false });
    return values as Partial<Record<K, string>>;
  } catch {
    return undefined;
  }
}

/** 비노출 입력 → 정책 검사. 실패하면 고정 문구 CliRefusal. */
export async function readPolicyPassword(io: CliIo): Promise<string> {
  let password: string;
  try {
    password = await readNewSecret(io.stdin, io.stderr);
  } catch (error) {
    if (error instanceof SecretInputError) throw new CliRefusal('input', error.message);
    throw error;
  }
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new CliRefusal(`policy_${policy.reason}`, '비밀번호는 12–128자(code point)여야 합니다');
  return password;
}

/** 트랜잭션 하나로 실행한다. 예외면 ROLLBACK. */
export async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** 실행기: 거부·오류를 종료 코드와 고정 문구로 바꾼다. DB 오류는 SQLSTATE만 출력(상세에 값이 들어갈 수 있음). */
export async function runCommand(io: CliIo, label: string, body: () => Promise<string>): Promise<number> {
  try {
    const done = await body();
    io.stdout.write(`${label}: ${done}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliRefusal) {
      io.stderr.write(`${label} 실패(${error.code}): ${error.message}. 변경 없음.\n`);
      return error.code === 'usage' ? EXIT_USAGE : EXIT_REFUSED;
    }
    io.stderr.write(`${label} 실패(db ${sqlState(error) ?? 'unknown'}). 변경 없음.\n`);
    return EXIT_REFUSED;
  }
}
