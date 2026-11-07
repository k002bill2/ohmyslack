/**
 * 측정 훅(W-10k C). `data/`가 import하는 유일한 측정 모듈 — 운영 빌드에서는 가드가 상수 false로 접혀 빈 함수만 남는다.
 * 실제 계측(`probe.ts`)은 측정 빌드에서만 동적 import되어 sink를 꽂는다.
 */
export type ProbeStage = 'ws' | 'emit';
export type ProbeSink = (stage: ProbeStage, id: string, createdAt: string) => void;

let sink: ProbeSink | null = null;

export function setProbeSink(next: ProbeSink | null): void {
  sink = next;
}

/** ① WS `message.created` 수신(`ws`) ② fold·emit 완료(`emit`). 측정 빌드가 아니면 아무것도 하지 않는다. */
export function probeMark(stage: ProbeStage, id: string, createdAt: string): void {
  if (import.meta.env.VITE_LATENCY_PROBE === '1') sink?.(stage, id, createdAt);
}
