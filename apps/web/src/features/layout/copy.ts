/**
 * W-11a 시안(01·09) 반영으로 새로 필요한 셸 문구. `ui/copy.ts`는 병렬 레인 충돌 방지로 수정하지 않는다(BRIEF 원칙 4).
 * 정본 COPY 편입 여부는 Jarvis 결정(REPORT 「문구 차이 표」).
 */
export const SHELL_COPY = Object.freeze({
  /** 대화 헤더 보조 줄(시안 01 「채널 · 멤버 3」 중 종류만 — 멤버 수는 데이터 없음). */
  kind: Object.freeze({ channel: '채널', dm: '대화' }),
  /** 헤더 오른쪽 스레드 패널 토글(시안 01). 열린 스레드가 있을 때만 렌더 = 닫기 동작. */
  closeThreadPanel: '스레드 패널 닫기',
});
