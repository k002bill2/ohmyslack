/**
 * fake-server 계약 위반 기록(순수). 위반은 비동기로 늦게 도착할 수 있어(누수 타이머·늦은 요청) 기록 시점의 테스트만으로는
 * 원인을 알 수 없다 — 서버를 만든 테스트(owner)와 기록 시점 테스트(at)를 함께 남긴다(QA P3-1).
 */
export interface ContractViolation {
  readonly detail: string;
  /** 위반 응답을 낸 FakeServer를 만든 테스트 — 누수의 원인 테스트. */
  readonly owner: string;
  /** 위반이 기록된 시점에 실행 중이던 테스트(없으면 `AFTER_TEST`). */
  readonly at: string;
}

export const AFTER_TEST = 'after-test';

export function formatViolations(found: readonly ContractViolation[]): string {
  const lines = found.map((v) => (v.owner === v.at ? `[${v.owner}] ${v.detail}` : `[원인: ${v.owner} / 기록 시점: ${v.at}] ${v.detail}`));
  return `fake-server 응답이 shared 계약과 다르다:\n${lines.join('\n')}`;
}

/** 위반 기록 저장소. `drain`은 쌓인 위반을 비우고 하나의 오류로 돌려준다(없으면 null). */
export function createViolationLog(currentTest: () => string | undefined) {
  let found: readonly ContractViolation[] = [];
  return {
    record(detail: string, owner: string | undefined): void {
      const at = currentTest() ?? AFTER_TEST;
      found = [...found, { detail, owner: owner ?? at, at }];
    },
    drain(): Error | null {
      const taken = found;
      found = [];
      return taken.length === 0 ? null : new Error(formatViolations(taken));
    },
  };
}
