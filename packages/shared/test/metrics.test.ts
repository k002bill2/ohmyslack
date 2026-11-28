import { describe, expect, it } from 'vitest';
import {
  bucketCount,
  CLIENT_METRIC_MAX_N,
  CLIENT_METRIC_MAX_RECORDS,
  clientMetricBatchSchema,
  COUNT_BUCKETS,
  toClientMetric,
  toMetricRecord,
} from '../src/metrics.js';

describe('count 구간값(R1)', () => {
  it('경계값은 자기 구간, 경계 사이는 아래 하한, 상한 이상은 상한으로 내린다', () => {
    expect(bucketCount(0)).toBe(0);
    expect(bucketCount(1)).toBe(1);
    expect(bucketCount(4)).toBe(2);
    expect(bucketCount(5)).toBe(5);
    expect(bucketCount(999)).toBe(500);
    expect(bucketCount(1000)).toBe(1000);
    expect(bucketCount(1_000_000)).toBe(1000);
  });

  it('음수·소수·비유한 값은 기록하지 않는다', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(bucketCount(bad)).toBeUndefined();
  });

  it('스키마는 구간 하한 집합만 허용한다(원시 개수·상한 초과 거부)', () => {
    for (const ok of COUNT_BUCKETS) expect(toMetricRecord({ event: 'client_state', state: 'offline', count: ok })).toBeDefined();
    for (const bad of [3, 7, 1001, 123456]) {
      expect(toMetricRecord({ event: 'client_state', state: 'offline', count: bad })).toBeUndefined();
      expect(toMetricRecord({ event: 'sync_result', trigger: 'connect', outcome: 'ok', caught_up_count: bad, duration_ms: 0 })).toBeUndefined();
    }
    expect(toMetricRecord({ event: 'auth_denied', action: 'login', reason: 'bad_credentials', count: 1 })).toBeDefined();
  });
});

describe('클라이언트 계측 배치', () => {
  const ok = { event: 'client_state', dims: { state: 'offline', count: 1 }, n: 3 };

  it('클라이언트 3종 레코드는 allowlist 레코드와 n으로 바뀐다', () => {
    expect(toClientMetric(ok)).toEqual({ record: { event: 'client_state', state: 'offline', count: 1 }, n: 3 });
    expect(toClientMetric({ event: 'read_sync_result', dims: { outcome: 'mismatch', duration_ms: 250 }, n: 1 })).toBeDefined();
    expect(
      toClientMetric({ event: 'sync_result', dims: { trigger: 'manual', outcome: 'ok', caught_up_count: 20, duration_ms: 1000 }, n: 1 }),
    ).toBeDefined();
  });

  it('서버 관찰 이벤트와 dims 안 event 덮어쓰기는 거부한다', () => {
    expect(toClientMetric({ event: 'auth_denied', dims: { action: 'login', reason: 'bad_credentials', count: 1 }, n: 1 })).toBeUndefined();
    expect(toClientMetric({ event: 'push_send_result', dims: { outcome: 'sent' }, n: 1 })).toBeUndefined();
    expect(toClientMetric({ ...ok, dims: { ...ok.dims, event: 'push_send_result' } })).toBeUndefined();
  });

  it('allowlist 밖 키·값과 n 범위 밖·여분 키는 거부한다(strict)', () => {
    expect(toClientMetric({ ...ok, dims: { ...ok.dims, url: 'https://x.test/a' } })).toBeUndefined();
    expect(toClientMetric({ ...ok, dims: { state: 'user-123', count: 1 } })).toBeUndefined();
    expect(toClientMetric({ ...ok, n: 0 })).toBeUndefined();
    expect(toClientMetric({ ...ok, n: CLIENT_METRIC_MAX_N + 1 })).toBeUndefined();
    expect(toClientMetric({ ...ok, n: CLIENT_METRIC_MAX_N })).toBeDefined();
    expect(toClientMetric({ ...ok, n: 1.5 })).toBeUndefined();
    expect(toClientMetric({ ...ok, extra: 1 })).toBeUndefined();
  });

  it('배치는 records 배열·길이 상한만 strict로 본다', () => {
    expect(clientMetricBatchSchema.safeParse({ records: [] }).success).toBe(true);
    expect(clientMetricBatchSchema.safeParse({ records: Array.from({ length: CLIENT_METRIC_MAX_RECORDS }, () => ok) }).success).toBe(true);
    expect(clientMetricBatchSchema.safeParse({ records: Array.from({ length: CLIENT_METRIC_MAX_RECORDS + 1 }, () => ok) }).success).toBe(false);
    expect(clientMetricBatchSchema.safeParse({ records: [], extra: 1 }).success).toBe(false);
    expect(clientMetricBatchSchema.safeParse([ok]).success).toBe(false);
  });
});
