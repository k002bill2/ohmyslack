import { createHash, randomBytes } from 'node:crypto';

/** 봇 토큰 형식(정본: TRD §5-2 2항). 접두사는 로그 마스킹·유출 스캔용이다. */
export const BOT_TOKEN_PREFIX = 'omsb_';
const TOKEN_BYTES = 32;
/** 접두사 + 32바이트 base64url(패딩 없음 43자). 형식이 다르면 DB를 조회하지 않는다. */
const TOKEN_SHAPE = /^omsb_[A-Za-z0-9_-]{43}$/;

/** CSPRNG 32바이트 원문. 호출자는 발급 응답에서 1회만 출력하고 어디에도 저장·로깅하지 않는다. */
export function generateBotToken(): string {
  return `${BOT_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/** DB에는 원문 전체 문자열의 SHA-256 hex만 저장한다. */
export function hashBotToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function hasBotTokenShape(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN_SHAPE.test(raw);
}
