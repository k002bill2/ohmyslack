import { describe, expect, it } from 'vitest';
import { BOT_UPLOAD_BYTES_PER_DAY, createBotRateLimiter } from '../../src/modules/bots/index.js';

/** 봇 첨부 업로드 상한(TRD §5-2 7항): 10건/분·100 MiB/일, 거부는 기록하지 않는다. */
describe('봇 업로드 상한', () => {
  it('하루 100 MiB를 넘기는 업로드는 거부되고 24시간 뒤 다시 허용된다', () => {
    let now = 0;
    const limiter = createBotRateLimiter(() => now);
    const chunk = 10 * 1024 * 1024;
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.takeUpload('t1', chunk).ok).toBe(true);
      now += 61_000; // 건수 창(1분)을 비운다.
    }
    expect(limiter.takeUpload('t1', BOT_UPLOAD_BYTES_PER_DAY - 10 * chunk).ok).toBe(true);
    now += 61_000;
    expect(limiter.takeUpload('t1', 1).ok).toBe(false);
    expect(limiter.takeUpload('t2', 1).ok).toBe(true);
    now += 24 * 60 * 60 * 1000;
    expect(limiter.takeUpload('t1', chunk).ok).toBe(true);
  });

  it('1분 10건을 넘기면 429 결정이고 거부는 바이트 사용량에 기록되지 않는다', () => {
    const limiter = createBotRateLimiter(() => 0);
    for (let i = 0; i < 10; i += 1) expect(limiter.takeUpload('t1', 1).ok).toBe(true);
    expect(limiter.takeUpload('t1', 1)).toEqual({ ok: false, retryAfterSeconds: 60 });
  });

  it('길이를 모르는 업로드의 바이트만 따로 검사·기록하고(건수 무관) 거부는 기록하지 않는다', () => {
    const limiter = createBotRateLimiter(() => 0);
    expect(limiter.takeUploadBytes('t1', BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    expect(limiter.takeUploadBytes('t1', 1)).toEqual({ ok: false, retryAfterSeconds: 24 * 60 * 60 });
    expect(limiter.takeUpload('t1', 1).ok).toBe(false);
    expect(limiter.takeUpload('t1', 0).ok).toBe(true);
  });

  it('바이트 잔여 판정(checkUploadBytes)은 기록하지 않고 일일 잔여가 없으면 거부한다', () => {
    const limiter = createBotRateLimiter(() => 0);
    expect(limiter.checkUploadBytes('t1', BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    expect(limiter.checkUploadBytes('t1', BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    expect(limiter.takeUploadBytes('t1', BOT_UPLOAD_BYTES_PER_DAY).ok).toBe(true);
    expect(limiter.checkUploadBytes('t1', 1)).toEqual({ ok: false, retryAfterSeconds: 24 * 60 * 60 });
  });
});
