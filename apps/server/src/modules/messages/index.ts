/** messages 모듈 공개 API(B1: 모듈 밖은 repo를 직접 import하지 않는다). */
export { createPgMessagesStore } from './repo.js';
export { createMessageEvents, type MessageEvents } from './events.js';
export type { MessagesStore } from './store.js';
export { MESSAGE_COLUMNS, toRecord, type MessageRow } from './repo.js';
export { toView } from './routes.js';
export type { MessageRecord } from './store.js';
