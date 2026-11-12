/**
 * 터치 우선 기기 판정(hover 없음 + 굵은 포인터). iOS Safari 등은 입력란에 프로그래밍 focus를 주면
 * 가상 키보드를 띄워 화면을 가리므로, 자동 포커스는 입력란이 아닌 대상으로 보낸다(WCAG 2.4.3 포커스 순서는 유지).
 * `matchMedia`가 없는 환경(SSR·jsdom)은 데스크톱으로 본다. 참고 출처: 일반 관념.
 */
export function prefersNoAutoKeyboard(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}
