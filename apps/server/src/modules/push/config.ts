import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { OpsLogger } from '../ops/logger.js';

/**
 * VAPID 설정(정본: TRD §6-2). 개인키는 서버 비밀 파일(600, 저장소 밖)을 환경 변수 경로로만 주입한다.
 * 미설정·읽기 실패·형식 위반이면 push만 비활성(undefined)이고 기동은 계속한다. 로그에는 경로·키를 싣지 않는다.
 */
export interface PushConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
  /** 공개키 sha256 hex 앞 16자. 키 회전 = 전 구독 재등록(구독 행을 이 값으로 구분). */
  readonly keyId: string;
}

export const PUSH_ENV_KEY_FILE = 'PUSH_VAPID_KEY_FILE';
export const PUSH_ENV_SUBJECT = 'PUSH_VAPID_SUBJECT';

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** P-256 비압축 공개키 65바이트, 개인키 32바이트. */
const keyFileSchema = z.object({
  public_key: b64url.refine((v) => Buffer.from(v, 'base64url').length === 65 && Buffer.from(v, 'base64url')[0] === 0x04),
  private_key: b64url.refine((v) => Buffer.from(v, 'base64url').length === 32),
});
/** `mailto:` 실제 주소. 공백·꺾쇠 금지(TRD §6-2). */
const SUBJECT_PATTERN = /^mailto:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

export function vapidKeyId(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export function isValidVapidSubject(subject: string): boolean {
  return SUBJECT_PATTERN.test(subject);
}

/** 키 파일 내용(JSON 문자열)과 subject로 설정을 만든다. 형식 위반이면 undefined. */
export function parsePushConfig(keyFileText: string, subject: string): PushConfig | undefined {
  if (!isValidVapidSubject(subject)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(keyFileText);
  } catch {
    return undefined;
  }
  const parsed = keyFileSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const publicKey = parsed.data.public_key;
  return Object.freeze({ publicKey, privateKey: parsed.data.private_key, subject, keyId: vapidKeyId(publicKey) });
}

/** 읽기 실패는 빈 내용으로(오류 메시지에 경로가 실리므로 전파하지 않는다). */
function readQuietly(path: string, readFile: (path: string) => string): string {
  if (path === '') return '';
  try {
    return readFile(path);
  } catch {
    return '';
  }
}

/** 환경 변수에서 설정을 읽는다. 둘 다 미설정이면 조용히 비활성, 일부만·잘못 설정이면 ops 이벤트 1건을 남긴다. */
export function loadPushConfig(
  env: Readonly<Record<string, string | undefined>>,
  logger: OpsLogger,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): PushConfig | undefined {
  const file = env[PUSH_ENV_KEY_FILE] ?? '';
  const subject = env[PUSH_ENV_SUBJECT] ?? '';
  if (file === '' && subject === '') return undefined;
  const config = parsePushConfig(readQuietly(file, readFile), subject);
  if (config === undefined) logger.log({ event: 'push_config_invalid', error_code: 'push_disabled' });
  return config;
}
