import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { markAccountGuard } from '../../http/access.js';
import { HttpError } from '../../http/errors.js';
import { pushSubscriptionCreateSchema, type PushSubscriptionCreated, type VapidPublicKeyResponse } from '../../shared.js';
import { accountGuard, requireAuth } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { PushService } from './service.js';

/** push 라우트(정본: TRD §3 push 행, §6-2). 모두 `account`: 현재 세션 기기의 구독 등록·해제. */
export interface PushRouteDeps {
  readonly auth: AuthService;
  readonly push: PushService;
}

const idParams = z.object({ id: z.uuid() });

function pathId(request: FastifyRequest): string {
  const parsed = idParams.safeParse(request.params);
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data.id;
}

export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const account = markAccountGuard(accountGuard(deps.auth));
  app.get('/api/push/vapid-public-key', { config: { access: 'account' }, preHandler: [account] }, async (): Promise<VapidPublicKeyResponse> => ({
    public_key: deps.push.publicKey(),
  }));
  app.post('/api/push/subscriptions', { config: { access: 'account' }, preHandler: [account] }, async (request, reply): Promise<PushSubscriptionCreated> => {
    const auth = requireAuth(request);
    // 비활성 판정을 형식 검사보다 먼저(비활성이면 본문과 무관하게 404).
    if (!deps.push.enabled) throw new HttpError(404, 'not_found');
    const body = pushSubscriptionCreateSchema.safeParse(request.body);
    if (!body.success) throw new HttpError(400, 'invalid_request');
    const id = await deps.push.subscribe(auth.user.id, auth.session.id, body.data);
    reply.code(201);
    return { subscription: { id } };
  });
  app.delete('/api/push/subscriptions/:id', { config: { access: 'account' }, preHandler: [account] }, async (request, reply) => {
    const auth = requireAuth(request);
    await deps.push.unsubscribe(auth.user.id, pathId(request));
    return reply.code(204).send();
  });
}
