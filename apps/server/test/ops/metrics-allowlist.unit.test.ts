import { describe, expect, it } from 'vitest';
import { METRIC_ALLOWLIST, metricRecordSchema, toMetricRecord } from '../../src/shared.js';

/** FR-OPS-03 보조·TR-SEC-09: 계측은 PRD §10 표의 이벤트·필드만 허용한다. */
const PRD_SECTION_10: Readonly<Record<string, readonly string[]>> = {
  message_send_result: ['outcome', 'conv_kind', 'has_thread', 'duration_ms'],
  sync_result: ['trigger', 'outcome', 'caught_up_count', 'duration_ms'],
  read_sync_result: ['outcome', 'duration_ms'],
  auth_denied: ['action', 'reason', 'count'],
  client_state: ['state', 'count'],
};

const VALID = Object.freeze({
  message_send_result: { event: 'message_send_result', outcome: 'ok', conv_kind: 'channel', has_thread: false, duration_ms: 250 },
  sync_result: { event: 'sync_result', trigger: 'reconnect', outcome: 'ok', caught_up_count: 10, duration_ms: 500 },
  read_sync_result: { event: 'read_sync_result', outcome: 'ok', duration_ms: 100 },
  auth_denied: { event: 'auth_denied', action: 'login', reason: 'bad_credentials', count: 1 },
  client_state: { event: 'client_state', state: 'offline', count: 2 },
});

/** PRD §10 "계측 필드로 넣지 않는" 항목들. */
const FORBIDDEN_KEYS = ['body', 'draft', 'email', 'display_name', 'ip', 'user_agent', 'user_id', 'device_id', 'session_id', 'message_id',
  'conversation_id', 'url', 'query', 'invite_link', 'cookie', 'token', 'error', 'stack', 'user_hash', 'request_id'];

describe('metrics allowlist (PRD §10)', () => {
  it('허용 목록은 PRD §10 표와 이벤트·필드가 정확히 같다', () => {
    expect(Object.fromEntries(Object.entries(METRIC_ALLOWLIST).map(([e, f]) => [e, [...f]]))).toEqual(PRD_SECTION_10);
    expect(Object.isFrozen(METRIC_ALLOWLIST)).toBe(true);
  });

  it('각 이벤트의 허용 필드만 가진 레코드는 통과하고 필드 집합이 허용 목록과 같다', () => {
    for (const [event, record] of Object.entries(VALID)) {
      expect(toMetricRecord(record), event).toEqual(record);
      expect(Object.keys(record).filter((k) => k !== 'event').sort()).toEqual([...(PRD_SECTION_10[event] ?? [])].sort());
    }
  });

  it('목록 밖 키는 하나라도 있으면 거부한다', () => {
    for (const [event, record] of Object.entries(VALID)) {
      for (const key of FORBIDDEN_KEYS) expect(toMetricRecord({ ...record, [key]: 'x' }), `${event}.${key}`).toBeUndefined();
    }
  });

  it('다른 이벤트의 필드·목록 밖 이벤트·누락 필드를 거부한다', () => {
    expect(toMetricRecord({ ...VALID.read_sync_result, trigger: 'reconnect' })).toBeUndefined();
    expect(toMetricRecord({ event: 'page_view', count: 1 })).toBeUndefined();
    expect(toMetricRecord({ event: 'read_sync_result', outcome: 'ok' })).toBeUndefined();
    expect(toMetricRecord('auth_denied')).toBeUndefined();
  });

  it('enum 자리의 임의 문자열(본문·이메일 등)과 비정수 bucket을 거부한다', () => {
    expect(toMetricRecord({ ...VALID.auth_denied, reason: 'OMS-CANARY-BODY-6f1c2a' })).toBeUndefined();
    expect(toMetricRecord({ ...VALID.client_state, state: 'user@example.test' })).toBeUndefined();
    expect(toMetricRecord({ ...VALID.read_sync_result, duration_ms: 1.5 })).toBeUndefined();
    expect(toMetricRecord({ ...VALID.read_sync_result, duration_ms: -1 })).toBeUndefined();
    expect(toMetricRecord({ ...VALID.message_send_result, has_thread: 'yes' })).toBeUndefined();
    expect(metricRecordSchema.safeParse(VALID.sync_result).success).toBe(true);
  });
});
