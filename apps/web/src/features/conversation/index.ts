/** conversation 기능 공개 API(DEV_DESIGN §2-2 B8). 다른 기능 폴더는 이 파일로만 참조한다. */
import './conversation.css';

export { MessageBody } from './MessageBody.js';
export { bodyMentionsName } from './render.js';
export { DateSeparator, NewMessagesDivider, dateSeparatorText, dayKey, type DateSeparatorProps } from './Dividers.js';
export { CONVERSATION_DESIGN_COPY } from './copy.js';
export { Composer, type ComposerProps, type MentionKey } from './Composer.js';
export { MENTION_CANDIDATE_LIMIT, type MentionCandidate } from './mention.js';
export { createDraftStore, type DraftStore } from './drafts.js';
export { MessageStatus, type MessageStatusProps } from './MessageStatus.js';
export { MessageItem, messageLabel, type MessageItemData, type MessageItemProps } from './MessageItem.js';
export {
  canRetry,
  createPending,
  sameKey,
  transition,
  type FailureKind,
  type MatchKey,
  type PendingMessage,
  type SendEvent,
  type SendStatus,
} from './send-status.js';
export {
  createSendController,
  type PostRequest,
  type PostResult,
  type SendController,
  type SendControllerDeps,
} from './send-controller.js';
export { canModify, failureView, type FailureView } from './MessageItemRules.js';
export { ThreadSummary, type ThreadSummaryProps } from './MessageItemThreadSummary.js';
export { lastServerSeq, scrolledToBottom } from './seen.js';
