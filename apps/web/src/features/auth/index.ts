/**
 * auth 기능 공개 API — CMP-19 `LoginForm` / `InviteAccept`(DESIGN_REFERENCE §6-2·§4-2, UI_STATES §2-9).
 * 문구는 `src/ui/copy.ts`(UI_STATES §9 채택분, COPY_GAPS G-01–G-13)에서 가져온다.
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
