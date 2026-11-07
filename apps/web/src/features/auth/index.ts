/**
 * auth 기능 공개 API — CMP-19 `LoginForm` / `InviteAccept`(DESIGN_REFERENCE §6-2·§4-2, UI_STATES §2-9).
 *
 * 정본 문구 없는 칸(렌더하지 않음 — 정본 확정 후 채운다):
 * - 로그인 자격 증명 오류(401 등 429 외 실패) 문구 — UI_STATES §8 Q-1. 현재 폼만 유지.
 * - 로그인 네트워크 오류(응답 없음) 문구·「다시 시도」 버튼 — 현재 폼 유지 + 「로그인」으로 재제출.
 * - 초대 수락 네트워크 오류·5xx `ErrorState` 문구 — UI_STATES §2-9는 「다시 시도」 버튼을 명시하나
 *   이번 브리프의 허용 문구 목록 밖이라 렌더하지 않음. 현재 폼 유지 + 「수락」으로 메모리 토큰 재시도(I-5).
 * - 초대 수락 표시 이름 입력 라벨 — 정본 없음. `displayNameLabel` prop이 주어질 때만 입력을 렌더하고
 *   `display_name`을 보낸다. 없으면 입력·필드 모두 생략(부모가 결정).
 * - 로그인/초대 화면 제목·안내문 — 정본 없음, 렌더하지 않음.
 */
export { LoginForm, SESSION_ENDED_TEXT, RATE_LIMITED_TEXT, type LoginFormProps, type LoginResult } from './LoginForm.js';
export {
  InviteAccept,
  INVITE_UNUSABLE_TEXT,
  parseInviteHash,
  type InviteAcceptProps,
  type InviteAcceptRequest,
  type InviteResult,
} from './InviteAccept.js';
