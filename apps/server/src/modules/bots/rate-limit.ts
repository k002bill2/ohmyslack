/**
 * 봇 토큰별 메모리 rate limit(정본: TRD §5-2 7항). 메시지 생성 30건/분, 수정 60건/분, 첨부 업로드 10건/분·100 MiB/일.
 * 초과는 429 + Retry-After, 저장 0.
 * 검사와 기록은 같은 동기 구간에서 한다(await 없음) — 동시 요청에서도 check-then-act 경쟁이 없다.
 */
export const BOT_RATE_LIMITS = Object.freeze({ create: 30, edit: 60, upload: 10 } as const);
export const BOT_RATE_WINDOW_MS = 60_000;
/** 첨부 업로드 바이트 상한(토큰별, 24시간 이동 창). */
export const BOT_UPLOAD_BYTES_PER_DAY = 100 * 1024 * 1024;
export const BOT_UPLOAD_BYTES_WINDOW_MS = 24 * 60 * 60 * 1000;
export type BotRateKind = keyof typeof BOT_RATE_LIMITS;

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export interface BotRateLimiter {
  /** 허용이면 즉시 기록한다. 거부는 기록하지 않는다. */
  take(tokenId: string, kind: BotRateKind): RateDecision;
  /** 첨부 업로드: 건수(10/분)와 바이트(100 MiB/일)를 함께 검사하고, 둘 다 허용일 때만 둘 다 기록한다. */
  takeUpload(tokenId: string, bytes: number): RateDecision;
  /** 바이트(100 MiB/일)만 검사·기록한다. 길이를 미리 모르는(chunked) 업로드가 body를 받은 뒤 쓴다. 거부는 기록하지 않는다. */
  takeUploadBytes(tokenId: string, bytes: number): RateDecision;
  /** 바이트(100 MiB/일)에 `bytes`만큼 잔여가 있는지 판정만 한다(기록 없음). chunked 업로드가 body를 받기 전에 쓴다. */
  checkUploadBytes(tokenId: string, bytes: number): RateDecision;
}

export function createBotRateLimiter(clock: () => number = Date.now): BotRateLimiter {
  const windows = new Map<string, number[]>();
  const byteWindows = new Map<string, { readonly at: number; readonly bytes: number }[]>();
  const countDecision = (key: string, limit: number, now: number): { decision: RateDecision; recent: number[] } => {
    const recent = (windows.get(key) ?? []).filter((at) => now - at < BOT_RATE_WINDOW_MS);
    if (recent.length < limit) return { decision: { ok: true }, recent };
    const oldest = recent[0] ?? now;
    return { decision: { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + BOT_RATE_WINDOW_MS - now) / 1000)) }, recent };
  };
  const byteDecision = (tokenId: string, bytes: number, now: number): { decision: RateDecision; used: { readonly at: number; readonly bytes: number }[] } => {
    const used = (byteWindows.get(tokenId) ?? []).filter((e) => now - e.at < BOT_UPLOAD_BYTES_WINDOW_MS);
    byteWindows.set(tokenId, used);
    const total = used.reduce((sum, e) => sum + e.bytes, 0);
    if (total + bytes <= BOT_UPLOAD_BYTES_PER_DAY) return { decision: { ok: true }, used };
    const oldest = used[0]?.at ?? now;
    return { decision: { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + BOT_UPLOAD_BYTES_WINDOW_MS - now) / 1000)) }, used };
  };
  return {
    takeUpload(tokenId, bytes) {
      const now = clock();
      const key = `upload:${tokenId}`;
      const counted = countDecision(key, BOT_RATE_LIMITS.upload, now);
      windows.set(key, counted.recent);
      if (!counted.decision.ok) return counted.decision;
      const sized = byteDecision(tokenId, bytes, now);
      if (!sized.decision.ok) return sized.decision;
      windows.set(key, [...counted.recent, now]);
      byteWindows.set(tokenId, [...sized.used, { at: now, bytes }]);
      return { ok: true };
    },
    takeUploadBytes(tokenId, bytes) {
      const now = clock();
      const sized = byteDecision(tokenId, bytes, now);
      if (!sized.decision.ok) return sized.decision;
      byteWindows.set(tokenId, [...sized.used, { at: now, bytes }]);
      return { ok: true };
    },
    checkUploadBytes(tokenId, bytes) {
      return byteDecision(tokenId, bytes, clock()).decision;
    },
    take(tokenId, kind) {
      const now = clock();
      const key = `${kind}:${tokenId}`;
      const recent = (windows.get(key) ?? []).filter((at) => now - at < BOT_RATE_WINDOW_MS);
      if (recent.length >= BOT_RATE_LIMITS[kind]) {
        windows.set(key, recent);
        const oldest = recent[0] ?? now;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + BOT_RATE_WINDOW_MS - now) / 1000)) };
      }
      windows.set(key, [...recent, now]);
      return { ok: true };
    },
  };
}
