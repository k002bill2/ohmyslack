/**
 * W-11a 시안(01·04·09) 반영으로 새로 필요한 사이드바 문구. `ui/copy.ts`는 병렬 레인 충돌 방지로 수정하지 않는다(BRIEF 원칙 4).
 * 정본 COPY 편입 여부는 Jarvis 결정(REPORT 「문구 차이 표」).
 */
export const SIDEBAR_SHELL_COPY = Object.freeze({
  /** nav 접근 이름이자 compact 공간 목록 화면 제목(시안 04 「공간」). 기존 `aria-label="공간"`과 같은 값. */
  spaces: '공간',
  /** 섹션 제목(시안 01·04·09). */
  sectionChannels: '채널',
  sectionDms: '대화',
  /** R4 시안 「이동…」 버튼(공간 전환기 열기, D §7-3 Ctrl/⌘+K). 보이는 글자 · 단축키 표기 · 접근 이름. */
  jump: '이동…',
  jumpKeys: 'Ctrl/⌘ K',
  jumpLabel: '공간 이동 (Ctrl/⌘+K)',
});
