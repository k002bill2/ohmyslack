import { CLIENT_METRIC_EVENTS, bucketCount, bucketDurationMs, toMetricRecord } from '../../shared.js';

/**
 * 로컬 계측 기록기(정본: PRD §10, TRD TR-SEC-09, DEV_DESIGN FR-OPS-03). 외부 전송 없이 Postgres `metric_daily`에 일 단위 횟수만 쌓는다.
 * - 입력은 `toMetricRecord`(shared allowlist)로 검증한다. 허용 밖 이벤트·키·값은 조용히 버린다.
 * - `duration_ms`는 기록 전에 고정 구간 하한(DURATION_BUCKETS_MS)으로 내린다 — 원시 ms는 저장되지 않는다.
 * - 절대 throw하지 않고 요청을 기다리게 하지 않는다(계측 실패가 전송 실패를 만들지 않음). 저장 실패는 코드만 로그한다.
 * - record는 DB를 부르지 않는다: 프로세스 메모리 Map에서 (day, event, dims)별로 +1만 하고, 주기 flush가 행마다 +n을 한 번에 올린다
 *   (SEC V1: 요청당 DB 쓰기 증폭·진행 중 쓰기 무상한 제거). 종료 시 마지막 flush를 시도하고, 실패는 최선 노력(다음 flush에 재합산).
 */
export type MetricDims = Readonly<Record<string, string | number | boolean>>;

/** metric_daily 저장소. dims는 검증된 레코드에서 event를 뺀 필드뿐이다. */
export interface MetricsStore {
  /**
   * (day, event, dims) 행의 count를 n 올린다(없으면 n으로 만든다). signal이 중단되면 기록기는 이 호출을 실패로 보고
   * 재합산했으므로, 구현은 아직 커밋하지 않았다면 커밋하지 말아야 한다(중복 집계 방지).
   */
  add(day: string, event: string, dims: MetricDims, n: number, signal?: AbortSignal): Promise<void>;
  /** day < cutoffDay 인 행을 지우고 지운 행 수를 돌려준다. signal 의미는 add와 같다. */
  pruneBefore(cutoffDay: string, signal?: AbortSignal): Promise<number>;
}

export interface MetricsRecorder {
  /**
   * 동기·무예외. 허용 밖 입력은 버린다. n(기본 1)은 같은 레코드를 몇 번으로 셀지 — 클라이언트가 메모리에서 합산해 보낸
   * 횟수(POST /api/metrics)를 한 번에 올린다. 1 이상 안전 정수가 아니면 버린다.
   */
  record(input: Readonly<Record<string, unknown>>, n?: number): void;
}

/** 보관 일수(PRD §10 "최대 7일 로컬 보관", R1 가정). 오늘을 포함해 7일 = cutoff는 오늘 - 6일. */
export const METRIC_RETENTION_DAYS = 7;
/** 보관 삭제 주기. 일 단위 집계라 하루 한 번이면 충분하다(기동 시 1회 + 24시간마다). */
export const METRIC_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 메모리 합산 → DB flush 주기. 일 단위 집계라 실시간성이 필요 없고, 10초면 비정상 종료 시 잃는 양이 작으면서
 * 부하가 몰려도 DB 쓰기는 주기당 (키 수)회로 묶인다.
 */
export const METRIC_FLUSH_INTERVAL_MS = 10_000;
/**
 * 버퍼 전체 키 상한(메모리 상한 보장). 키 = (day, event, dims)이고 dims는 전부 allowlist enum·boolean·고정 구간값이다.
 * 서버 4종의 하루 조합은 수백 개 이하(가장 큰 message_send_result도 outcome×conv_kind×has_thread×구간 = 180)지만,
 * 클라이언트 3종은 이론상 더 크다(sync_result = trigger 4 × outcome 5 × caught_up_count 11 × duration_ms 9 = 1980 > 1024).
 * 그래서 클라이언트 3종은 METRIC_MAX_CLIENT_KEYS로 따로 묶고, 남는 자리(≥ 768)를 서버 4종에 보장한다(SEC V1).
 * 넘으면 DB 장애가 길게 이어진 것이므로 새 키는 버린다(기존 키 증분은 계속).
 */
export const METRIC_MAX_KEYS = 1024;
/**
 * 버퍼 안 클라이언트 3종(CLIENT_METRIC_EVENTS) 키 상한(SEC V1·R1). 웹 정상 클라이언트는 한 주기에 64키 이하(웹 METRIC_MAX_KEYS)
 * 이고 사용자는 소수라 256이면 넉넉하다. 이 상한 때문에 클라이언트가 아무리 보내도 서버 4종 자리(METRIC_MAX_KEYS - 256)는 남는다.
 * flush로 버퍼를 바꿀 때 다시 센다. drain 실패 재합산도 merge를 거치므로 같은 상한이 적용된다.
 */
export const METRIC_MAX_CLIENT_KEYS = 256;
/** 종료 시 마지막 flush를 기다리는 상한. DB가 멈춰 있어도 종료가 매달리지 않게 한다. */
export const METRIC_CLOSE_TIMEOUT_MS = 2000;
/**
 * 저장소 호출(행별 add·보관 삭제) 1회의 상한. 넘기면 그 호출은 포기(AbortSignal)하고 실패로 본다 — 저장소가 끝나지 않아도
 * 진행 중 flush가 풀려 다음 주기에 다시 시도한다(QA-REPORT-2 v1_hang). 순서 제약: METRIC_CLOSE_TIMEOUT_MS(2초) &lt; 이 값 &lt;
 * METRIC_FLUSH_INTERVAL_MS(10초) — 한 주기 안에 포기가 확정되고, 종료 상한이 먼저 끝난다.
 */
export const METRIC_WRITE_TIMEOUT_MS = 5000;
/**
 * 계측 쿼리의 서버측 statement_timeout(트랜잭션 로컬). METRIC_WRITE_TIMEOUT_MS보다 짧아서, 잠금 대기·느린 문장은 보통 기록기
 * 상한 전에 DB가 취소한다(포기한 행이 나중에 커밋되는 일을 줄임). 연결 대기가 길면 문장이 늦게 시작해 상한 전에 취소되지 않을 수
 * 있다 — 그때는 커밋 전 signal 확인이 막고, 남는 COMMIT 경합(상한 초과 flush마다 최대 1행)은 metrics-store.ts 참조.
 */
export const METRIC_STATEMENT_TIMEOUT_MS = 3000;
/**
 * 상한으로 포기했지만 아직 정착(resolve/reject)하지 않은 저장 호출 수의 상한(QA P3-2). 이 수 이상이면 그 주기의 저장 호출을
 * 건너뛰고 버퍼에 그대로 두며 metric_write_failed를 낸다. 포기된 호출은 pg 연결(또는 연결 대기 자리)을 계속 쥐고 있을 수 있으므로,
 * pool 기본 max 10보다 충분히 작게 2로 둔다 — 기록기 단독으로는 계측이 일반 요청 연결 슬롯(또는 대기 자리)을 최대 2개까지만
 * 붙잡는다. 검사는 호출 시작 때만 하므로, 기동 시·24시간마다 retention 호출이 겹치면 최대 3개다.
 * 트레이드오프(의도): 포기된 호출이 끝내 정착하지 않으면(RST 없는 죽은 소켓) 2개가 찬 뒤 계측 쓰기가 정지한다. 풀 슬롯 보호를
 * 계측 지속보다 우선한 것이며, 정지 중에도 주기마다 metric_write_failed가 나와 관측된다. 정착하는 순간 다음 주기에 재개한다.
 * 해소: 앱 pool connectionTimeoutMillis(5초, db/pool.ts)로 대기자를 정리하고 keepalive가 죽은 소켓을 끊는다. 카운터는 저장소 객체별로 기록기·retention이 공유한다.
 */
export const METRIC_MAX_ABANDONED = 2;

/** onError로 넘기는 고정 코드(값·식별자 없음). */
export type MetricErrorCode = 'metric_write_failed' | 'metric_buffer_full' | 'metric_client_buffer_full';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 집계 일자(UTC 기준 'YYYY-MM-DD'). 서버·DB 세션 시간대와 무관하게 주입된 시계만으로 정한다. */
export function metricDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** 보관 경계: 이 날짜보다 이전(day < cutoff) 행은 지운다. */
export function retentionCutoff(now: number): string {
  return metricDay(now - (METRIC_RETENTION_DAYS - 1) * DAY_MS);
}

/**
 * 주입된 기록기를 감싸 record의 예외를 삼킨다. 앱·봇 리스너는 받은 기록기를 항상 이것으로 감싼다 —
 * 어떤 기록기를 주입해도 요청 결과(상태·본문)가 바뀌지 않게(TR-SEC-09 "계측 실패가 메시지 처리를 막지 않음").
 */
export function guardedRecorder(recorder: MetricsRecorder): MetricsRecorder {
  return Object.freeze({
    record(input: Readonly<Record<string, unknown>>, n?: number) {
      try {
        recorder.record(input, n);
      } catch {
        // 계측 실패는 호출자에게 올리지 않는다.
      }
    },
  });
}

/** 계측을 끈 기록기(저장소 없는 골격·테스트 기본값). */
export const noopMetrics: MetricsRecorder = Object.freeze({ record: () => undefined });

export interface MetricsRecorderDeps {
  readonly store: MetricsStore;
  readonly clock: () => number;
  /** 저장 실패·버퍼 초과 신호(예: ops 로그). 이 콜백의 예외도 삼킨다. */
  readonly onError?: (code: MetricErrorCode) => void;
  /** 기본 METRIC_FLUSH_INTERVAL_MS(테스트 주입용). */
  readonly flushIntervalMs?: number;
  /** 기본 METRIC_MAX_KEYS(테스트 주입용). */
  readonly maxKeys?: number;
  /** 기본 METRIC_WRITE_TIMEOUT_MS(테스트 주입용). */
  readonly writeTimeoutMs?: number;
}

export interface PendingMetricsRecorder extends MetricsRecorder {
  /** 진행 중인 flush를 기다린 뒤 현재 버퍼를 한 번 flush하고 끝날 때까지(테스트·종료용). 실패해도 다시 시도하지 않는다. */
  idle(): Promise<void>;
  /** 주기 flush를 멈추고 마지막 flush를 최대 METRIC_CLOSE_TIMEOUT_MS까지 기다린다(서버 종료용). */
  close(): Promise<void>;
}

interface Pending {
  readonly day: string;
  readonly event: string;
  readonly dims: MetricDims;
  n: number;
}

/** 버퍼 키: dims 키를 정렬해 같은 조합이 키 순서와 무관하게 한 키로 모이게 한다. */
function bufferKey(day: string, event: string, dims: MetricDims): string {
  const sorted = Object.fromEntries(Object.keys(dims).sort().map((k) => [k, dims[k]]));
  return `${day}|${event}|${JSON.stringify(sorted)}`;
}

/** 구간값 필드와 그 버킷 함수(duration_ms는 ms 구간, count·caught_up_count는 개수 구간 — R1). */
const BUCKETED_FIELDS: Readonly<Record<string, (v: number) => number | undefined>> = Object.freeze({
  duration_ms: bucketDurationMs,
  count: bucketCount,
  caught_up_count: bucketCount,
});

/** 구간값 필드를 구간 하한으로 바꾼 새 객체(입력 불변). 버킷팅할 수 없으면 필드를 빼서 검증에서 떨어지게 한다. */
function withBucketedFields(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [field, toBucket] of Object.entries(BUCKETED_FIELDS)) {
    if (!(field in out)) continue;
    const raw = out[field];
    const bucketed = typeof raw === 'number' ? toBucket(raw) : undefined;
    if (bucketed === undefined) delete out[field];
    else out[field] = bucketed;
  }
  return out;
}

const isClientEvent = (event: string): boolean => (CLIENT_METRIC_EVENTS as readonly string[]).includes(event);

class MetricWriteTimeout extends Error {}
class MetricWriteSaturated extends Error {}

/** 저장소별 "포기·미정착" 호출 수. 같은 저장소를 쓰는 기록기와 retention이 한 카운터를 본다(main.ts 배선 변경 없이). */
interface AbandonedCount {
  value: number;
}
const abandonedByStore = new WeakMap<MetricsStore, AbandonedCount>();
function abandonedFor(store: MetricsStore): AbandonedCount {
  const found = abandonedByStore.get(store);
  if (found !== undefined) return found;
  const created: AbandonedCount = { value: 0 };
  abandonedByStore.set(store, created);
  return created;
}

/**
 * 저장소 호출 1회를 ms로 묶는다. 상한에 닿으면 signal을 중단하고 MetricWriteTimeout으로 거부한다(원래 호출은 기다리지 않음).
 * 저장소의 동기 예외도 거부로 바꾸고, 포기한 호출이 나중에 거부돼도 unhandled rejection이 되지 않게 받아 둔다.
 */
async function withWriteTimeout<T>(ms: number, abandoned: AbandonedCount, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (abandoned.value >= METRIC_MAX_ABANDONED) throw new MetricWriteSaturated('metric write saturated');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = Promise.resolve().then(() => work(controller.signal));
  call.catch(() => undefined);
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // 포기한 호출은 정착할 때까지 센다(연결·대기 자리를 쥐고 있을 수 있음).
      abandoned.value += 1;
      call.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        abandoned.value -= 1;
      });
      reject(new MetricWriteTimeout('metric write timeout'));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([call, cap]);
  } finally {
    clearTimeout(timer);
  }
}

export function createMetricsRecorder(deps: MetricsRecorderDeps): PendingMetricsRecorder {
  const { store, clock } = deps;
  const maxKeys = deps.maxKeys ?? METRIC_MAX_KEYS;
  const writeTimeoutMs = deps.writeTimeoutMs ?? METRIC_WRITE_TIMEOUT_MS;
  const abandoned = abandonedFor(store);
  let buffer = new Map<string, Pending>();
  // 현재 버퍼 안 클라이언트 3종 키 수(METRIC_MAX_CLIENT_KEYS 검사용). buffer를 새 Map으로 바꿀 때 0으로 되돌린다.
  let clientKeys = 0;
  let inFlight: Promise<void> | undefined;
  // 버퍼 초과 신호는 종류별로 flush 주기당 한 번만(초과가 이어져도 로그가 요청 수만큼 늘지 않게). 클라이언트 상한은 별도 코드 —
  // 운영 로그에서 클라이언트 포화(V1)와 DB 장애로 인한 전체 포화를 구분한다.
  let fullReported = false;
  let clientFullReported = false;
  const fail = (code: MetricErrorCode): void => {
    try {
      deps.onError?.(code);
    } catch {
      // 계측 오류 보고의 실패도 요청 경로로 올리지 않는다.
    }
  };
  const merge = (day: string, event: string, dims: MetricDims, n: number): void => {
    const key = bufferKey(day, event, dims);
    const found = buffer.get(key);
    if (found !== undefined) {
      found.n += n;
      return;
    }
    const isClient = isClientEvent(event);
    if (isClient && clientKeys >= METRIC_MAX_CLIENT_KEYS) {
      if (!clientFullReported) fail('metric_client_buffer_full');
      clientFullReported = true;
      return;
    }
    if (buffer.size >= maxKeys) {
      if (!fullReported) fail('metric_buffer_full');
      fullReported = true;
      return;
    }
    buffer.set(key, { day, event, dims, n });
    if (isClient) clientKeys += 1;
  };
  /**
   * 버퍼를 떼어 행마다 순서대로 +n(기록기가 기다리는 저장 호출 ≤ 1). 실패한 행은 버퍼에 다시 합산한다(재합산은 이 catch 한 곳).
   * 상한 초과(저장소 정지)면 남은 행은 부르지 않고 그대로 재합산한다 — flush 1회가 (행 수 × 상한)으로 늘어나지 않게.
   * 포기·미정착 호출이 METRIC_MAX_ABANDONED개면 저장소를 부르지 않고 전부 재합산한다(신호는 주기당 1회).
   */
  const drain = async (batch: readonly Pending[]): Promise<void> => {
    let failed = false;
    let stalled = false;
    for (const row of batch) {
      if (stalled) {
        merge(row.day, row.event, row.dims, row.n);
        continue;
      }
      try {
        await withWriteTimeout(writeTimeoutMs, abandoned, (signal) => store.add(row.day, row.event, row.dims, row.n, signal));
      } catch (error) {
        failed = true;
        stalled = error instanceof MetricWriteTimeout || error instanceof MetricWriteSaturated;
        merge(row.day, row.event, row.dims, row.n);
      }
    }
    if (failed) fail('metric_write_failed');
  };
  /** flush 1회. 진행 중이면 새로 시작하지 않고 진행 중인 것을 돌려준다(겹침 없음). */
  const flush = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    fullReported = false;
    clientFullReported = false;
    if (buffer.size === 0) return Promise.resolve();
    const batch = [...buffer.values()];
    buffer = new Map();
    clientKeys = 0;
    const run = drain(batch).finally(() => {
      inFlight = undefined;
    });
    inFlight = run;
    return run;
  };
  const timer = setInterval(() => void flush(), deps.flushIntervalMs ?? METRIC_FLUSH_INTERVAL_MS);
  timer.unref?.();
  const idle = async (): Promise<void> => {
    if (inFlight !== undefined) await inFlight;
    await flush();
  };
  return {
    record(input, n = 1) {
      try {
        if (!Number.isSafeInteger(n) || n < 1) return;
        const record = toMetricRecord(withBucketedFields(input));
        if (record === undefined) return;
        const { event, ...dims } = record;
        merge(metricDay(clock()), event, dims, n);
      } catch {
        fail('metric_write_failed');
      }
    },
    idle,
    async close() {
      clearInterval(timer);
      let limit: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((resolve) => {
        limit = setTimeout(resolve, METRIC_CLOSE_TIMEOUT_MS);
        limit.unref?.();
      });
      await Promise.race([idle(), cap]);
      clearTimeout(limit);
    },
  };
}

/** 보관 삭제 1회(오늘 포함 7일 밖 행). */
export function pruneMetrics(store: MetricsStore, now: number, signal?: AbortSignal): Promise<number> {
  return store.pruneBefore(retentionCutoff(now), signal);
}

/**
 * 기동 시 1회 + 주기마다 보관 삭제(attachments `startRetentionTimer`와 같은 모양: 겹침 방지·unref·정지 함수).
 * 실패·상한(timeoutMs) 초과는 onError로만 알리고 다음 주기에 다시 시도한다 — 삭제가 끝나지 않아도 겹침 방지 플래그가 풀린다.
 */
export function startMetricRetention(
  store: MetricsStore,
  clock: () => number,
  onError: (error: unknown) => void,
  intervalMs: number = METRIC_RETENTION_INTERVAL_MS,
  timeoutMs: number = METRIC_WRITE_TIMEOUT_MS,
): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(() => withWriteTimeout(timeoutMs, abandonedFor(store), (signal) => pruneMetrics(store, clock(), signal)))
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
