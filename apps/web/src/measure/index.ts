/**
 * 측정 빌드 게이트(W-10k C). `import.meta.env.VITE_LATENCY_PROBE`를 `import()` 지점에 리터럴로 둬야
 * 운영 빌드에서 분기가 상수 접힘으로 제거되고 probe 청크가 생성되지 않는다(test/measure/prod-absent.test.ts가 증명).
 */
export function maybeInstallProbe(): Promise<void> | undefined {
  if (import.meta.env.VITE_LATENCY_PROBE === '1') return import('./probe.js').then((m) => m.install());
  return undefined;
}
