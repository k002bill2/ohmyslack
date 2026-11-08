export {
  ATTACHMENTS_PROJECTION_SQL,
  bindInTx,
  boundIdsOf,
  createPgAttachmentsStore,
  purgeMessageBlobsInTx,
  type AttachmentMeta,
  type AttachmentProjectionRow,
  type AttachmentsStore,
  type BindResult,
} from './repo.js';
export { createAttachmentsService, startRetentionTimer, type AttachmentsService } from './service.js';
export {
  attachmentCspOnSend,
  attachmentPathId,
  downloadAs,
  registerAttachmentRoutes,
  registerUploadRoute,
  toAttachmentView,
  uploadAs,
} from './routes.js';
export { sniff } from './sniff.js';
