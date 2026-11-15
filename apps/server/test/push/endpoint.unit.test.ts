import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from '../../src/shared.js';

/** push endpoint 허용목록(TRD §6-2, SSRF 방어). 2026-11-16 Chromium 계열 FCM 대체 호스트 jmt<n>.google.com 추가. */
describe('isAllowedPushEndpoint', () => {
  it('Chromium 계열이 내는 FCM 대체 호스트 jmt<n>.google.com은 /fcm/send/ 경로일 때만 허용한다', () => {
    expect(isAllowedPushEndpoint('https://jmt17.google.com/fcm/send/d9IG14abc:APA91b')).toBe(true);
    expect(isAllowedPushEndpoint('https://jmt0.google.com/fcm/send/x')).toBe(true);
  });
  it('패턴 밖 google.com 호스트·경로·포트·스킴은 거부한다', () => {
    for (const endpoint of [
      'https://jmt17.google.com/other/x',
      'https://jmt17.google.com/fcm/send',
      'https://jmt.google.com/fcm/send/x',
      'https://xjmt17.google.com/fcm/send/x',
      'https://jmt17.google.com.evil.com/fcm/send/x',
      'https://a.jmt17.google.com/fcm/send/x',
      'https://jmt17.google.com:8443/fcm/send/x',
      'http://jmt17.google.com/fcm/send/x',
      'https://u:p@jmt17.google.com/fcm/send/x',
      'https://www.google.com/fcm/send/x',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });
  it('기존 허용 호스트는 그대로다', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
  });
});
