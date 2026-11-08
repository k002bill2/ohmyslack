import { describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { loadPushConfig } from '../../src/modules/push/index.js';

/** VAPID 설정 로드(TRD §6-2): 미설정·형식 위반이면 비활성, 잘못 설정이면 ops 이벤트 1건(경로·키 미포함). */
const PATH_CANARY = '/secret/OMS-CANARY-VAPIDPATH-77/k.json';

function spy(): { lines: string[]; logger: { log: (f: Readonly<Record<string, unknown>>) => void } } {
  const lines: string[] = [];
  return { lines, logger: { log: (f) => lines.push(JSON.stringify(f)) } };
}

const keys = generateVAPIDKeys();
const file = JSON.stringify({ public_key: keys.publicKey, private_key: keys.privateKey });

describe('loadPushConfig', () => {
  it('둘 다 미설정이면 undefined이고 로그 0', () => {
    const s = spy();
    expect(loadPushConfig({}, s.logger, () => file)).toBeUndefined();
    expect(s.lines).toHaveLength(0);
  });

  it('파일만 설정·subject 없음이면 undefined이고 로그 1건', () => {
    const s = spy();
    expect(loadPushConfig({ PUSH_VAPID_KEY_FILE: PATH_CANARY }, s.logger, () => file)).toBeUndefined();
    expect(s.lines).toHaveLength(1);
  });

  it('파일 읽기 실패면 undefined이고 로그 1건에 경로가 없다', () => {
    const s = spy();
    const env = { PUSH_VAPID_KEY_FILE: PATH_CANARY, PUSH_VAPID_SUBJECT: 'mailto:ops@example.test' };
    expect(
      loadPushConfig(env, s.logger, (p) => {
        throw new Error(`ENOENT ${p}`);
      }),
    ).toBeUndefined();
    expect(s.lines).toHaveLength(1);
    expect(s.lines.join('')).not.toContain('OMS-CANARY-VAPIDPATH-77');
  });

  it('subject가 꺾쇠·공백·mailto 아님이면 undefined', () => {
    for (const subject of ['mailto:<ops@example.test>', 'mailto:ops @example.test', 'https://example.test', 'mailto:']) {
      const s = spy();
      expect(loadPushConfig({ PUSH_VAPID_KEY_FILE: PATH_CANARY, PUSH_VAPID_SUBJECT: subject }, s.logger, () => file)).toBeUndefined();
      expect(s.lines.join('')).not.toContain(keys.privateKey);
    }
  });

  it('키 형식 위반(JSON 아님·길이 틀림)이면 undefined', () => {
    const env = { PUSH_VAPID_KEY_FILE: PATH_CANARY, PUSH_VAPID_SUBJECT: 'mailto:ops@example.test' };
    expect(loadPushConfig(env, spy().logger, () => 'not json')).toBeUndefined();
    expect(loadPushConfig(env, spy().logger, () => JSON.stringify({ public_key: 'AAAA', private_key: keys.privateKey }))).toBeUndefined();
  });

  it('유효하면 설정과 16자 hex keyId를 돌려주고 로그 0', () => {
    const s = spy();
    const config = loadPushConfig({ PUSH_VAPID_KEY_FILE: PATH_CANARY, PUSH_VAPID_SUBJECT: 'mailto:ops@example.test' }, s.logger, () => file);
    expect(config?.publicKey).toBe(keys.publicKey);
    expect(config?.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.lines).toHaveLength(0);
  });
});
