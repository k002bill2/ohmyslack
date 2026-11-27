import { bucketDurationMs, toMetricRecord } from '../../shared.js';

/**
 * 로컬 계측 기록기(정본: PRD §10, TRD TR-SEC-09, DEV_DESIGN FR-OPS-03). 외부 전송 없이 Postgres `metric_daily`에 일 단위 횟수만 쌓는다.
 * - 입력은 `toMetricRecord`(shared allowlist)로 검증한다. 허용 밖 이벤트·키·값은 조용히 버린다.
 * - `duration_ms`는 기록 전에 고정 구간 하한(DURATION_BUCKETS_MS)으로 내린다 — 원시 ms는 저장되지 않는다.
 * - 절대 throw하지 않고 요청을 기다리게 하지 않는다(계측 실패가 전송 실패를 만들지 않음). 저장 실패는 코드만 로그한다.
 */
export type MetricDims = Readonly<Record<string, string | number | boolean>>;

/** metric_daily 저장소. dims는 검증된 레코드에서 event를 뺀 필드뿐이다. */
export interface MetricsStore {
  /** (day, event, dims) 행의 count를 1 올린다(없으면 1로 만든다). */
  increment(day: string, event: string, dims: MetricDims): Promise<void>;
  /** day < cutoffDay 인 행을 지우고 지운 행 수를 돌려준다. */
  pruneBefore(cutoffDay: string): Promise<number>;
}

export interface MetricsRecorder {
  /** 동기·무예외. 허용 밖 입력은 버린다. */
  record(input: Readonly<Record<string, unknown>>): void;
}

/** 보관 일수(PRD §10 "최대 7일 로컬 보관", R1 가정). 오늘을 포함해 7일 = cutoff는 오늘 - 6일. */
export const METRIC_RETENTION_DAYS = 7;
/** 보관 삭제 주기. 일 단위 집계라 하루 한 번이면 충분하다(기동 시 1회 + 24시간마다). */
export const METRIC_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    record(input: Readonly<Record<string, unknown>>) {
      try {
        recorder.record(input);
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
  /** 저장 실패 신호(예: ops 로그). 이 콜백의 예외도 삼킨다. */
  readonly onError?: () => void;
}

export interface PendingMetricsRecorder extends MetricsRecorder {
  /** 진행 중인 저장이 모두 끝날 때까지(테스트·종료용). */
  idle(): Promise<void>;
}

/** duration_ms를 구간 하한으로 바꾼 새 객체(입력 불변). 버킷팅할 수 없으면 필드를 빼서 검증에서 떨어지게 한다. */
function withBucketedDuration(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!('duration_ms' in input)) return { ...input };
  const { duration_ms: raw, ...rest } = input;
  const bucketed = typeof raw === 'number' ? bucketDurationMs(raw) : undefined;
  return bucketed === undefined ? rest : { ...rest, duration_ms: bucketed };
}

export function createMetricsRecorder(deps: MetricsRecorderDeps): PendingMetricsRecorder {
  const { store, clock } = deps;
  const pending = new Set<Promise<void>>();
  const fail = (): void => {
    try {
      deps.onError?.();
    } catch {
      // 계측 오류 보고의 실패도 요청 경로로 올리지 않는다.
    }
  };
  return {
    record(input) {
      try {
        const record = toMetricRecord(withBucketedDuration(input));
        if (record === undefined) return;
        const { event, ...dims } = record;
        const day = metricDay(clock());
        // 다음 마이크로태스크에서 저장한다: 저장소의 동기 예외도 거부로 바뀌어 아래 catch가 받는다.
        const task: Promise<void> = Promise.resolve()
          .then(() => store.increment(day, event, dims))
          .catch(fail)
          .finally(() => pending.delete(task));
        pending.add(task);
      } catch {
        fail();
      }
    },
    async idle() {
      await Promise.allSettled([...pending]);
    },
  };
}

/** 보관 삭제 1회(오늘 포함 7일 밖 행). */
export function pruneMetrics(store: MetricsStore, now: number): Promise<number> {
  return store.pruneBefore(retentionCutoff(now));
}

/**
 * 기동 시 1회 + 주기마다 보관 삭제(attachments `startRetentionTimer`와 같은 모양: 겹침 방지·unref·정지 함수).
 * 실패는 onError로만 알리고 다음 주기에 다시 시도한다.
 */
export function startMetricRetention(
  store: MetricsStore,
  clock: () => number,
  onError: (error: unknown) => void,
  intervalMs: number = METRIC_RETENTION_INTERVAL_MS,
): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(() => pruneMetrics(store, clock()))
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
