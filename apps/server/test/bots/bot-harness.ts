import { expect } from 'vitest';
import { runBootstrapOwner } from '../../bin/lib/bootstrap.js';
import { createBotEvents, createBotService, type BotConnectionsCloseEvent, type BotService } from '../../src/modules/bots/index.js';
import type { TestSchema } from '../support/test-db.js';
import { migratedSchema, pipedIo } from '../auth/bootstrap-harness.js';

/** 봇 통합 테스트 공통: 마이그레이션 + owner/워크스페이스 + 서비스 + 연결 닫기 훅 기록기. */
export interface BotFixture {
  readonly schema: TestSchema;
  readonly ownerId: string;
  readonly service: BotService;
  readonly closed: BotConnectionsCloseEvent[];
  now: number;
}

export const OWNER_PASSWORD = 'owner-password-0001';

export async function botFixture(): Promise<BotFixture> {
  const schema = await migratedSchema();
  const io = pipedIo(`${OWNER_PASSWORD}\n`);
  expect(await runBootstrapOwner(['--email', 'owner@example.test', '--name', 'Owner', '--workspace', 'Home'], io, schema.pool)).toBe(0);
  const owner = await schema.pool.query<{ id: string }>("SELECT id FROM users WHERE kind = 'human'");
  const events = createBotEvents();
  const closed: BotConnectionsCloseEvent[] = [];
  events.onConnectionsClose((event) => closed.push(event));
  const fixture: BotFixture = {
    schema,
    ownerId: owner.rows[0]?.id ?? '',
    closed,
    now: Date.parse('2026-11-08T00:00:00Z'),
    service: createBotService({ pool: schema.pool, events, clock: () => fixture.now }),
  };
  return fixture;
}
