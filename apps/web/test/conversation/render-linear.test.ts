import { beforeAll, describe, expect, it } from 'vitest';
import { parseBody } from '../../src/features/conversation/render.js';

/**
 * FR-MSG-10 보조(F-1 회귀): 서식 파서는 입력 길이에 선형이어야 한다.
 * 절대 ms를 단언하지 않고(CI 편차), 1,000/4,000자 1회 처리 시간(호출당 ms) 비율로 판정한다.
 * 선형이면 4,000/1,000 ≈ 4, 2차면 ≈ 16. 상한 8은 그대로 두고, 측정을 부하에 강하게 만든다:
 * - 표본 길이 맞춤: 길이마다 반복 횟수를 보정해 표본 하나가 SAMPLE_MS 안팎이 되게 한다 — 짧은 1k 표본만 선점을 피하는 비대칭이 없다.
 * - 교차·순서 교대: 1k→4k, 4k→1k를 번갈아 재 한 길이만 잡음 구간에 몰리지 않는다.
 * - 최솟값: 잡음(병렬 워커·GC·coverage 계측)은 시간을 늘리기만 하므로 각 길이의 최솟값은 참값 위에서 참값으로 수렴한다.
 *   RUNS 뒤 비율이 상한을 넘으면 MAX_RUNS까지 더 잰다 — 선형은 4 쪽으로, 2차는 16 쪽으로 수렴하므로 판별력은 유지된다.
 */
const RUNS = 9;
const MAX_RUNS = 40;
const SAMPLE_MS = 2;
const MAX_REPS = 2000;
const MAX_RATIO = 8;

/** body를 reps번 처리한 호출당 ms. */
function perCallMs(body: string, reps: number): number {
  const start = performance.now();
  for (let i = 0; i < reps; i += 1) parseBody(body);
  return (performance.now() - start) / reps;
}

/** 표본 하나가 SAMPLE_MS 안팎이 되는 반복 횟수(1회 시간 최솟값 기준). */
function repsFor(body: string): number {
  let once = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i += 1) once = Math.min(once, perCallMs(body, 1));
  return Math.min(MAX_REPS, Math.max(1, Math.ceil(SAMPLE_MS / Math.max(once, 1e-4))));
}

/** 1k·4k 호출당 시간 최솟값을 교차로 재고 비율을 낸다. */
function linearRatio(short: string, long: string): { readonly t1: number; readonly t4: number; readonly ratio: number; readonly runs: number } {
  const reps = [repsFor(short), repsFor(long)] as const;
  let t1 = Number.POSITIVE_INFINITY;
  let t4 = Number.POSITIVE_INFINITY;
  let runs = 0;
  while (runs < MAX_RUNS) {
    if (runs % 2 === 0) {
      t1 = Math.min(t1, perCallMs(short, reps[0]));
      t4 = Math.min(t4, perCallMs(long, reps[1]));
    } else {
      t4 = Math.min(t4, perCallMs(long, reps[1]));
      t1 = Math.min(t1, perCallMs(short, reps[0]));
    }
    runs += 1;
    if (runs >= RUNS && t4 / t1 <= MAX_RATIO) break;
  }
  return { t1, t4, ratio: t4 / t1, runs };
}

function repeatTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** 닫히지 않은 패턴을 반복하는 최악 입력. 각 항목은 4,000자에서 서버 상한(MESSAGE_BODY_MAX)과 같다. */
export const WORST: readonly (readonly [string, string])[] = [
  ['* 반복', '*'],
  ['` 반복', '`'],
  ['[ 반복', '['],
  ['**x 반복(닫히지 않은 굵게)', '**x '],
  ['[a]( 반복(닫히지 않은 링크)', '[a]('],
  ['[a](http://a.co/[ 반복(긴 URL 후보)', '[a](http://a.co/'],
  ['`` 반복(빈 인라인 코드)', '`` '],
  ['** ** 반복(flanking 실패)', '** '],
  ['# - 1. 줄 반복', '# x\n- y\n1. z\n'],
  ['** `a` 반복(코드 건너뛰는 굵게 닫기)', '** `a` '],
  ['http://a.co/** 반복(자동 링크 안 서식 기호)', 'http://a.co/** '],
  ['[`**`]( 반복(링크 라벨 백틱, 닫히지 않은 링크)', '[`**`]('],
  ['[`](https://a.co) ** 반복(링크 라벨 백틱 + 굵게 닫기)', '[`](https://a.co) ** '],
  ['**a [`**`]( 반복(굵게 안 링크 모양 백틱)', '**a [`**`]( '],
];

describe('FR-MSG-10 4,000자 최악 입력 선형 시간', () => {
  // 모든 최악 입력 경로를 미리 최적화 단계까지 데워 첫 사례만 JIT 전환 비용을 떠안지 않게 한다.
  beforeAll(() => {
    for (let r = 0; r < 5; r += 1) for (const [, unit] of WORST) perCallMs(repeatTo(unit, 4000), 20);
  });

  it.each(WORST)('FR-MSG-10 %s: 4,000자/1,000자 시간 비율 ≤ 8', (_name, unit) => {
    expect(repeatTo(unit, 4000)).toHaveLength(4000);
    const { t1, t4, ratio, runs } = linearRatio(repeatTo(unit, 1000), repeatTo(unit, 4000));
    console.info(`[render-linear] ${_name}: 1k=${(t1 * 1000).toFixed(1)}µs 4k=${(t4 * 1000).toFixed(1)}µs ratio=${ratio.toFixed(2)} runs=${runs}`);
    expect(ratio).toBeLessThanOrEqual(MAX_RATIO);
  });
});
