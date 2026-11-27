import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPgAuthStore } from '../../src/modules/auth/index.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { createMetricsRecorder, type PendingMetricsRecorder } from '../../src/modules/ops/metrics.js';
import { createPgMetricsStore } from '../../src/modules/ops/metrics-store.js';
import type { TestSchema } from '../support/test-db.js';
import { testApp } from '../support/auth-app.js';
import { migratedSchema } from './bootstrap-harness.js';

/** 인증 int 테스트 공통: 마이그레이션된 스키마 + 활성 사용자 1명 + pg 저장소 앱. 로그는 stdout과 배열에 함께 쓴다. */
export interface AuthIntContext {
  readonly schema: TestSchema;
  readonly app: FastifyInstance;
  readonly userId: string;
  readonly logs: string[];
  /** 운영과 같은 pg 계측 기록기(SEC R3: metric_daily도 카나리아 덤프 대상). 덤프 전에 idle()로 flush한다. */
  readonly metrics: PendingMetricsRecorder;
  now: number;
}

export async function setupAuthInt(email: string, secret: string): Promise<AuthIntContext> {
  const schema = await migratedSchema();
  const userId = randomUUID();
  await schema.pool.query(
    "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, $2, 'Member', $3, 'active')",
    [userId, email, await hashPassword(secret)],
  );
  const logs: string[] = [];
  const stdout = createOpsLogger();
  const metrics = createMetricsRecorder({ store: createPgMetricsStore(schema.pool), clock: Date.now });
  const ctx: AuthIntContext = { schema, userId, logs, metrics, now: Date.now(), app: undefined as unknown as FastifyInstance };
  const app = testApp({
    metrics,
    authStore: createPgAuthStore(schema.pool),
    clock: () => ctx.now,
    logger: { log: (fields) => (stdout.log(fields), createOpsLogger((line) => logs.push(line)).log(fields)) },
  });
  return Object.assign(ctx, { app });
}

export async function teardownAuthInt(ctx: AuthIntContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.metrics.close();
  await ctx?.schema.drop();
}
