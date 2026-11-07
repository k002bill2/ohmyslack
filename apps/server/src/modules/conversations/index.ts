/** conversations 모듈 공개 API(B1: 모듈 밖은 repo를 직접 import하지 않는다). */
export { createPgConversationsStore } from './repo.js';
export { createConversationEvents, type ConversationEvents } from './events.js';
export type { ConversationsStore } from './store.js';
