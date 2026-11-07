import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 비밀번호 해시·정책(정본: TRD §5-1 S9). Node 내장 crypto.argon2(argon2id)만 쓴다.
 * 저장 형식은 PHC 문자열 `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>`(base64, 패딩 없음).
 */
export const ARGON2_PARAMS = Object.freeze({
  memory: 19456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
});

export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_CODE_POINTS = 128;

const ARGON2_VERSION = 19;
/** 저장값으로 받아들일 파라미터 상한(조작된 해시로 메모리·CPU를 고갈시키지 못하게 막는다). */
const VERIFY_BOUNDS = Object.freeze({ maxMemory: 262_144, maxPasses: 10, maxParallelism: 8, minSalt: 16, minTag: 16, maxTag: 64 });
const PHC_PATTERN = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export type PolicyResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'too_short' | 'too_long' };

interface Argon2Input {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
  readonly salt: Buffer;
}

/** 길이는 UTF-16 단위가 아니라 Unicode code point로 센다. 조합 규칙은 두지 않는다. */
export function checkPasswordPolicy(password: string): PolicyResult {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_CODE_POINTS) return { ok: false, reason: 'too_short' };
  if (length > PASSWORD_MAX_CODE_POINTS) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

/** users.email_norm 규칙: trim → NFC → 소문자. */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

function derive(password: string, input: Argon2Input): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password,
        nonce: input.salt,
        memory: input.memory,
        passes: input.passes,
        parallelism: input.parallelism,
        tagLength: input.tagLength,
      },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

/** 정책을 통과한 비밀번호만 해시한다(정책 위반은 예외 — 호출자가 먼저 checkPasswordPolicy로 거른다). */
export async function hashPassword(password: string): Promise<string> {
  if (!checkPasswordPolicy(password).ok) throw new Error('비밀번호 정책 위반');
  const salt = randomBytes(ARGON2_PARAMS.saltLength);
  const { memory, passes, parallelism, tagLength } = ARGON2_PARAMS;
  const tag = await derive(password, { memory, passes, parallelism, tagLength, salt });
  return `$argon2id$v=${ARGON2_VERSION}$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

interface ParsedPhc extends Argon2Input {
  readonly tag: Buffer;
}

function parsePhc(stored: string): ParsedPhc | undefined {
  const match = PHC_PATTERN.exec(stored);
  if (match === null) return undefined;
  const [version, memory, passes, parallelism] = match.slice(1, 5).map(Number);
  const salt = Buffer.from(match[5] ?? '', 'base64');
  const tag = Buffer.from(match[6] ?? '', 'base64');
  if (version !== ARGON2_VERSION || memory === undefined || passes === undefined || parallelism === undefined) return undefined;
  const b = VERIFY_BOUNDS;
  if (parallelism < 1 || parallelism > b.maxParallelism) return undefined;
  if (memory < 8 * parallelism || memory > b.maxMemory) return undefined;
  if (passes < 1 || passes > b.maxPasses) return undefined;
  if (salt.length < b.minSalt || tag.length < b.minTag || tag.length > b.maxTag) return undefined;
  return { memory, passes, parallelism, tagLength: tag.length, salt, tag };
}

/** PHC 문자열을 파싱해 같은 파라미터로 다시 계산하고 timingSafeEqual로 비교한다. 형식 오류는 false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePhc(stored);
  if (parsed === undefined) return false;
  const candidate = await derive(password, parsed);
  return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
}
