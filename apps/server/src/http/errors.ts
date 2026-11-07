import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorResponse } from '../shared.js';

/** 클라이언트에 보낼 오류. code만 노출하고 본문·SQL·stack은 싣지 않는다(TRD §3). */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function errorBody(request: FastifyRequest, code: string): ErrorResponse {
  return { error: { code, request_id: request.id } };
}

export function sendError(request: FastifyRequest, reply: FastifyReply, statusCode: number, code: string): FastifyReply {
  return reply.code(statusCode).send(errorBody(request, code));
}

/** Fastify 내부 오류(본문 파싱·크기 초과 등)는 상태 코드만 살리고 code는 고정 문자열로 바꾼다. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
  if (status === 413) return new HttpError(413, 'payload_too_large');
  if (status === 415) return new HttpError(415, 'unsupported_media_type');
  if (status >= 400 && status < 500) return new HttpError(400, 'invalid_request');
  return new HttpError(500, 'internal_error');
}
