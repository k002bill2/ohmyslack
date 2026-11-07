import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, type } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageView } from '../apps/server/src/shared.js';
import { addUser, signIn, type Session } from '../apps/server/test/auth/members-int-harness.js';
import { createChannel } from '../apps/server/test/conversations/conv-int-harness.js';
import { http, setupE2e, teardownE2e, type E2eContext } from '../e2e/support/harness.js';
import { WsClient } from '../e2e/support/ws-client.js';
import { summarize, tallyDelivery, type Receipt } from './stats.ts';

/**
 * FR-SYNC-01 (a) 프로토콜 지연(DEV_DESIGN §6-5). 같은 맥·같은 시계에서
 * 메시지 `created_at`(서버 시계) → 다른 연결의 `message.created` 수신 시각 차이를 잰다.
 * 메시지 ID·본문은 메모리에서만 상관에 쓰고 결과 파일에는 구간값·백분위·표본 수만 남긴다(PRD §10).
 * 이 결과는 보조 증거다. FR-SYNC-01 판정은 (b) 표시 지연 p95 ≤ 1000ms다.
 */

const USERS = 10;
const DEVICES = 2;
const RATE = Number(process.env['PERF_RATE'] ?? '5');
const DURATION_S = Number(process.env['PERF_DURATION_S'] ?? '600');
const DRAIN_MS = 3000;
const VERDICT_NOTE = 'FR-SYNC-01 판정은 (b) 표시 지연 p95 ≤ 1000ms다. 이 (a) 프로토콜 지연은 보조 증거이며 (a)만으로 통과를 주장하지 않는다.';

interface Conn {
  readonly user: number;
  readonly session: Session;
  readonly ws: WsClient;
}

interface Sent {
  readonly message: string;
  readonly createdAt: number;
  readonly senderConn: number;
}

/** 부하 중 누적하는 측정 상태(실행 동안만 갱신, 끝나면 읽기만 한다). */
interface LoadResult {
  readonly sent: Sent[];
  attempts: number;
  errors: number;
  readonly commitMs: number[];
  lockWaitsMax: number;
  readonly startedAt: string;
  elapsedS: number;
}

let ctx: E2eContext | undefined;
let conns: Conn[] = [];
let channel = '';
/** 측정 시작 시점의 환경(커밋 SHA 포함). 실행 중 작업 트리가 바뀌어도 측정한 코드를 가리킨다. */
let env: Record<string, unknown> = {};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function sessions(c: E2eContext): Promise<{ user: number; session: Session }[]> {
  const emails = ['a@example.test', 'b@example.test', 'c@example.test'];
  for (let i = emails.length; i < USERS; i += 1) {
    const email = `u${i}@example.test`;
    await addUser(c.schema, email, 'member');
    emails.push(email);
  }
  const out: { user: number; session: Session }[] = [];
  for (const [user, email] of emails.entries()) {
    for (let d = 0; d < DEVICES; d += 1) out.push({ user, session: await signIn(c.app, email) });
  }
  return out;
}

async function connect(c: E2eContext): Promise<void> {
  const all = await sessions(c);
  const owner = all[0];
  if (owner === undefined) throw new Error('세션 없음');
  channel = await createChannel(c.app, owner.session, `perf-${randomUUID().slice(0, 8)}`);
  for (const s of all.filter((x) => x.user !== 0 && all.indexOf(x) % DEVICES === 0)) {
    await http(c, 'POST', `/api/conversations/${channel}/join`, s.session);
  }
  const clock = await c.schema.pool.query<{ id: string }>('SELECT last_change_id::text AS id FROM sync_clock WHERE id = 1');
  const cursor = Number(clock.rows[0]?.id ?? 0);
  for (const s of all) {
    const ws = await WsClient.open(c.wsUrl, s.session);
    ws.subscribe(channel, cursor);
    await ws.subscribed(channel);
    conns.push({ ...s, ws });
  }
}

/** 서버 전체에서 대기 중(미허가) 잠금 수. R-08(sync_clock 단일 행 경합) 관찰용 표본. */
async function lockWaits(c: E2eContext): Promise<number> {
  const res = await c.schema.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted');
  return Number(res.rows[0]?.n ?? 0);
}

async function sendOne(c: E2eContext, idx: number, out: LoadResult): Promise<void> {
  const senderConn = idx % conns.length;
  const conn = conns[senderConn] as Conn;
  const t0 = performance.now();
  try {
    const body = { client_message_id: randomUUID(), body: 'perf' };
    const res = await http<{ message: MessageView }>(c, 'POST', `/api/conversations/${channel}/messages`, conn.session, body);
    out.commitMs.push(performance.now() - t0);
    out.sent.push({ message: res.message.id, createdAt: Date.parse(res.message.created_at), senderConn });
  } catch {
    out.errors += 1;
  }
}

/** 합계 RATE msg/s를 고정 일정(드리프트 없음)으로 연결을 돌아가며 보낸다. 응답을 기다리지 않고 다음을 보낸다. */
async function runLoad(c: E2eContext): Promise<LoadResult> {
  const out: LoadResult = { sent: [], attempts: 0, errors: 0, commitMs: [], lockWaitsMax: 0, startedAt: new Date().toISOString(), elapsedS: 0 };
  const total = Math.round(RATE * DURATION_S);
  const interval = 1000 / RATE;
  const start = performance.now();
  const inflight: Promise<void>[] = [];
  let nextSample = start;
  for (let i = 0; i < total; i += 1) {
    const wait = start + i * interval - performance.now();
    if (wait > 0) await sleep(wait);
    out.attempts += 1;
    inflight.push(sendOne(c, i, out));
    if (performance.now() >= nextSample) {
      nextSample += 1000;
      inflight.push(lockWaits(c).then((n) => void (out.lockWaitsMax = Math.max(out.lockWaitsMax, n))));
    }
  }
  await Promise.all(inflight);
  out.elapsedS = Math.round((performance.now() - start) / 100) / 10;
  return out;
}

interface Measured {
  readonly latencies: number[];
  readonly receipts: Receipt[];
  readonly expected: Map<string, Set<number>>;
  /** 발신 연결이 자기 메시지를 되받은 수(기대 수신자가 아니므로 누락·중복 집계에서 뺀다). */
  readonly senderEcho: number;
}

function measure(load: LoadResult): Measured {
  const createdAt = new Map(load.sent.map((s) => [s.message, s.createdAt]));
  const senderOf = new Map(load.sent.map((s) => [s.message, s.senderConn]));
  const expected = new Map(load.sent.map((s) => [s.message, new Set(conns.map((_, i) => i).filter((i) => i !== s.senderConn))]));
  const latencies: number[] = [];
  const receipts: Receipt[] = [];
  let senderEcho = 0;
  for (const [conn, c] of conns.entries()) {
    for (const r of c.ws.received) {
      if (r.frame.type !== 'message.created' || r.frame.conversation_id !== channel) continue;
      const message = r.frame.message.id;
      if (senderOf.get(message) === conn) {
        senderEcho += 1;
        continue;
      }
      receipts.push({ message, conn });
      const created = createdAt.get(message);
      if (created !== undefined && expected.get(message)?.has(conn) === true) latencies.push(performance.timeOrigin + r.at - created);
    }
  }
  return { latencies, receipts, expected, senderEcho };
}

function sh(cmd: string, args: readonly string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function environment(c: E2eContext): Promise<Record<string, unknown>> {
  const pg = await c.schema.pool.query<{ v: string }>('SHOW server_version');
  const cpu = cpus();
  return {
    node: process.version,
    os: `${type()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model ?? 'unknown'} × ${cpu.length}`,
    postgres: pg.rows[0]?.v ?? 'unknown',
    commit: sh('git', ['rev-parse', 'HEAD']),
    dirty: sh('git', ['status', '--porcelain']) !== '',
  };
}

function writeReport(report: Record<string, unknown>): string {
  const dir = join(process.cwd(), 'reports', 'perf');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `latency-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

beforeAll(async () => {
  ctx = await setupE2e();
  env = await environment(ctx);
  await connect(ctx);
}, 120_000);

afterAll(async () => {
  for (const c of conns) await c.ws.close();
  conns = [];
  await teardownE2e(ctx);
}, 60_000);

describe('FR-SYNC-01 (a) 프로토콜 지연', () => {
  it('FR-SYNC-01 20연결·5msg/s·10분에서 커밋부터 다른 기기 화면 표시까지 p95가 1000ms 이하이고 오류율·환경이 기록된다', async () => {
    if (ctx === undefined) throw new Error('ctx 없음');
    const load = await runLoad(ctx);
    await sleep(DRAIN_MS);
    const { latencies, receipts, expected, senderEcho } = measure(load);
    const delivery = tallyDelivery(expected, receipts);
    const latency = summarize(latencies);
    const report = {
      kind: 'FR-SYNC-01 (a) protocol latency',
      verdict_note: VERDICT_NOTE,
      definition: '수신 시각(Node performance.timeOrigin + now) − 메시지 created_at(서버 시계, 같은 맥). created_at은 커밋 전 서비스 진입 시각이라 커밋→수신의 상한이다.',
      load: { connections: conns.length, users: USERS, devices_per_user: DEVICES, rate_msg_s: RATE, duration_s: DURATION_S, elapsed_s: load.elapsedS, started_at: load.startedAt },
      sends: { attempts: load.attempts, ok: load.sent.length, errors: load.errors, error_rate: load.attempts === 0 ? 0 : load.errors / load.attempts },
      delivery: { ...delivery, sender_echo: senderEcho },
      latency_ms: latency ?? null,
      commit_roundtrip_ms: summarize(load.commitMs) ?? null,
      r08_pg_lock_waits_max: load.lockWaitsMax,
      environment: env,
    };
    const path = writeReport(report);
    console.info(`FR-SYNC-01 (a) 결과: ${path}\n${JSON.stringify({ sends: report.sends, delivery, latency_ms: latency, commit_roundtrip_ms: report.commit_roundtrip_ms, r08_pg_lock_waits_max: load.lockWaitsMax })}`);

    expect(conns).toHaveLength(USERS * DEVICES);
    expect(load.errors).toBe(0);
    expect(delivery).toMatchObject({ missing: 0, duplicates: 0, unexpected: 0 });
    expect(latency?.count).toBe(load.sent.length * (conns.length - 1));
    expect(latency?.min ?? -1).toBeGreaterThanOrEqual(0);
    // (a) ≤ 1000ms는 필요조건일 뿐이다. 판정은 (b) 표시 지연(QA-FR-SYNC-01).
    expect(latency?.p95 ?? Infinity).toBeLessThanOrEqual(1000);
  }, (DURATION_S + 120) * 1000);
});
