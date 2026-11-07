/** sync 기능 공개 API(DEV_DESIGN §2-2 B8). */
export { ConnectionBanner, CONNECTION_TEXT } from './ConnectionBanner.js';
export { adoptAccount, clearCheckpoints, readCheckpoint, writeCheckpoint, type StorageLike } from './checkpoint.js';
export { createSessionBus, type SessionBus, type SessionEndReason } from './session.js';
