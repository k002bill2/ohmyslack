/**
 * 봇 토큰별 메모리 rate limit(정본: TRD §5-2 7항). 메시지 생성 30건/분, 수정 60건/분. 초과는 429 + Retry-After, 저장 0.
 * 검사와 기록은 같은 동기 구간에서 한다(await 없음) — 동시 요청에서도 check-then-act 경쟁이 없다.
 */
export const BOT_RATE_LIMITS = Object.freeze({ create: 30, edit: 60 } as const);
export const BOT_RATE_WINDOW_MS = 60_000;
export type BotRateKind = keyof typeof BOT_RATE_LIMITS;

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export interface BotRateLimiter {
  /** 허용이면 즉시 기록한다. 거부는 기록하지 않는다. */
  take(tokenId: string, kind: BotRateKind): RateDecision;
}

export function createBotRateLimiter(clock: () => number = Date.now): BotRateLimiter {
  const windows = new Map<string, number[]>();
  return {
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
