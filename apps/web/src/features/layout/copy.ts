/**
 * W-11a 시안(01·09) 반영으로 새로 필요한 셸 문구. `ui/copy.ts`는 병렬 레인 충돌 방지로 수정하지 않는다(BRIEF 원칙 4).
 * 정본 COPY 편입 여부는 Jarvis 결정(REPORT 「문구 차이 표」).
 */
export const SHELL_COPY = Object.freeze({
  /** 대화 헤더 보조 줄(시안 01 「채널 · 멤버 3」 — 멤버 수를 아직 모를 때·DM은 종류만). */
  kind: Object.freeze({ channel: '채널', dm: '대화' }),
  /** 시안 01 「채널 · 멤버 n」(멤버 수는 이미 받은 대화 멤버 목록 — 새 API 호출 없음, W-11d). */
  channelMeta: (count: number) => `채널 · 멤버 ${count}`,
  /** 헤더 오른쪽 스레드 패널 토글(시안 01). 열린 스레드가 있을 때만 렌더 = 닫기 동작. */
  closeThreadPanel: '스레드 패널 닫기',
  /** R4 분할선(role=separator) 접근 이름 — 조작법을 함께 읽어 준다(시안 Main). */
  navSplit: '내비게이션 폭 조절 (←→, Enter 접기, 더블클릭 초기화)',
  threadSplit: '스레드 폭 조절 (←→, Enter 닫기, 더블클릭 초기화)',
});
