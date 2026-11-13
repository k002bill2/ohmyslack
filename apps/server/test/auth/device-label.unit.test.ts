import { describe, expect, it } from 'vitest';
import { deviceLabelFor } from '../../src/modules/auth/device-label.js';
import { SESSION_DEVICE_LABEL_MAX } from '../../src/shared.js';

/** TRD §5-3 2항 라벨 생성 표: 기기 6종 × 브라우저 4종, 위에서부터 첫 일치, 하나라도 모르면 null. */
const DEVICES: readonly (readonly [string, string])[] = [
  ['(iPhone; CPU iPhone OS 17_4 like Mac OS X)', 'iPhone'],
  ['(iPad; CPU OS 17_4 like Mac OS X)', 'iPad'],
  ['(Linux; Android 14; Pixel 8)', 'Android'],
  ['(Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
  ['(Windows NT 10.0; Win64; x64)', 'Windows'],
  ['(X11; Linux x86_64)', 'Linux'],
];

const BROWSERS: readonly (readonly [string, string])[] = [
  ['AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51', 'Edge'],
  ['Gecko/20100101 Firefox/125.0', 'Firefox'],
  ['AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15', 'Firefox'],
  ['AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Chrome'],
  ['AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1', 'Chrome'],
  ['AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 'Safari'],
];

describe('deviceLabelFor', () => {
  it('기기 6종 × 브라우저 4종(대체 표식 포함) 전 조합이 「{기기} · {브라우저}」이고 버전·OS 버전을 담지 않는다', () => {
    for (const [devicePart, device] of DEVICES) {
      for (const [browserPart, browser] of BROWSERS) {
        const label = deviceLabelFor(`Mozilla/5.0 ${devicePart} ${browserPart}`);
        expect(label, `${device} × ${browser}`).toBe(`${device} · ${browser}`);
        expect(label).not.toMatch(/\d/);
        expect([...(label ?? '')].length).toBeLessThanOrEqual(SESSION_DEVICE_LABEL_MAX);
      }
    }
  });

  it('첫 일치 순서: Android UA의 Linux는 Android, Edge UA의 Chrome·Safari는 Edge, iPad 데스크톱 모드(Macintosh)는 Mac', () => {
    expect(deviceLabelFor('Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabelFor('Mozilla/5.0 (Windows NT 10.0) Chrome/124.0 Safari/537.36 Edg/124.0')).toBe('Windows · Edge');
    expect(deviceLabelFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15')).toBe('Mac · Safari');
    expect(deviceLabelFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Macintosh Safari/604.1')).toBe('iPhone · Safari');
  });

  it('모르는 UA·한 축만 아는 UA·빈 값·헤더 없음은 null이다(부분 라벨 없음)', () => {
    expect(deviceLabelFor(undefined)).toBeNull();
    expect(deviceLabelFor('')).toBeNull();
    expect(deviceLabelFor('lightMyRequest')).toBeNull();
    expect(deviceLabelFor('curl/8.7.1')).toBeNull();
    expect(deviceLabelFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Opera')).toBeNull();
    expect(deviceLabelFor('Mozilla/5.0 (PlayStation 5) Chrome/124.0 Safari/537.36')).toBeNull();
    expect(deviceLabelFor('Chrome/124.0')).toBeNull();
  });

  it('표 밖 값은 만들지 않는다: 아무리 긴 UA여도 결과는 표 값 조합이고 상한 64자 이하다', () => {
    const huge = `Mozilla/5.0 (Windows NT 10.0) ${'X'.repeat(10_000)} Firefox/125.0`;
    const label = deviceLabelFor(huge);
    expect(label).toBe('Windows · Firefox');
    expect(SESSION_DEVICE_LABEL_MAX).toBe(64);
  });
});
