import Fastify, { type FastifyInstance } from 'fastify';

/** 플러그인·라우트 조립 지점. 골격 단계에서는 빈 인스턴스만 반환한다(라우트는 Slice A부터). */
export function buildApp(): FastifyInstance {
  return Fastify({ logger: false });
}
