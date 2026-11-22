import { z } from 'zod';
import { messageSchema } from './messages.js';

/** WebSocket 프레임 계약(정본: TRD §4 이벤트 표, §5 frame 64 KiB, §7 heartbeat 제안값). */
export const WS_PATH = '/api/ws';
/** WS frame 최대 크기(TRD §5). 초과 frame은 파싱·저장 없이 거절한다(TR-SEC-06). */
export const WS_FRAME_MAX_BYTES = 64 * 1024;
/** heartbeat 간격·허용 미응답 횟수(TRD §7 제안값). */
export const WS_HEARTBEAT_MS = 25_000;
export const WS_HEARTBEAT_MISSES = 2;
/** 정책 위반(세션 만료·폐기·비활성화) close code(RFC 6455 §7.4.1, TRD §5-1 S7). */
export const WS_CLOSE_POLICY = 1008;

const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** client→server. 스키마 밖 프레임은 `error{code,retryable}`로 응답한다. */
export const wsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation.subscribe'), conversation_id: z.uuid(), after_cursor: cursor }).strict(),
  z.object({ type: z.literal('conversation.unsubscribe'), conversation_id: z.uuid() }).strict(),
]);

export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

export const wsErrorCodeSchema = z.enum(['invalid_frame', 'frame_too_large', 'not_found', 'cursor_expired', 'unavailable']);
export type WsErrorCode = z.infer<typeof wsErrorCodeSchema>;

/** server→client. */
export const wsServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation.subscribed'), conversation_id: z.uuid(), through_cursor: cursor }),
  z.object({ type: z.literal('message.created'), conversation_id: z.uuid(), change_id: cursor, message: messageSchema }),
  z.object({ type: z.literal('message.updated'), conversation_id: z.uuid(), change_id: cursor, message: messageSchema }),
  z.object({
    type: z.literal('message.deleted'),
    conversation_id: z.uuid(),
    change_id: cursor,
    message_id: z.uuid(),
    seq: z.number().int(),
    deleted_at: z.string(),
  }),
  z.object({
    type: z.literal('read.updated'),
    conversation_id: z.uuid(),
    thread_root_id: z.uuid().nullable(),
    last_read_seq: z.number().int(),
    updated_at: z.string(),
  }),
  z.object({ type: z.literal('sync.required') }),
  /** 봇 연결 전용: 그 봇의 대화 멤버십 변화(BOT_CHANNEL_SPEC §4-3). 사람 연결에는 보내지 않는다. */
  z.object({ type: z.literal('membership.changed'), conversation_id: z.uuid(), state: z.enum(['joined', 'left']) }),
  /** 사람 연결 전용: owner가 채널을 삭제했다(FR-CONV-06). 그 채널 멤버였던 사용자의 모든 연결에 보낸다. */
  z.object({ type: z.literal('conversation.deleted'), conversation_id: z.uuid() }),
  z.object({ type: z.literal('error'), code: wsErrorCodeSchema, retryable: z.boolean(), conversation_id: z.uuid().optional() }),
]);

export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;
