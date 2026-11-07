import type { RunContext } from './lib/cli.ts';

/** 테스트 DB 안전장치(정본: DEV_DESIGN §5-1). 실제 DB에는 접속하지 않고 URL만 검사한다. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);
const REQUIRED_DB_SUFFIX = '_test';

export interface DbUrlCheck {
  readonly ok: boolean;
  readonly reason: string;
}

export function checkTestDbUrl(raw: string | undefined): DbUrlCheck {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'TEST_DATABASE_URL이 설정되지 않았습니다' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'TEST_DATABASE_URL을 URL로 해석할 수 없습니다' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `postgres 스킴이 아닙니다(${url.protocol})` };
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, reason: `호스트 ${url.hostname}는 허용되지 않습니다(127.0.0.1·localhost만)` };
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (dbName === '' || !dbName.endsWith(REQUIRED_DB_SUFFIX)) {
    return { ok: false, reason: `DB 이름 "${dbName}"이 ${REQUIRED_DB_SUFFIX}로 끝나지 않습니다` };
  }
  return { ok: true, reason: `테스트 DB 확인: ${url.hostname}/${dbName}` };
}

export async function run(_argv: readonly string[], ctx: RunContext): Promise<number> {
  const result = checkTestDbUrl(ctx.env.TEST_DATABASE_URL);
  if (!result.ok) {
    ctx.err(`assert-test-db: 거부 — ${result.reason}`);
    return 1;
  }
  ctx.out(`assert-test-db: ${result.reason}`);
  return 0;
}
