import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { radixScales } from '../../src/ui/tokens.js';
import { detectInstallMode, InstallHint, registerServiceWorker, useInstallPrompt } from '../../src/features/pwa';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = join(WEB, 'public');

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}
interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly lang: string;
  readonly icons: readonly ManifestIcon[];
}

const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;
const html = readFileSync(join(WEB, 'index.html'), 'utf8');

/** PNG IHDR의 너비·높이(바이트 16–23). */
function pngSize(file: string): string {
  const buf = readFileSync(file);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/** 디자인 §9-2 산출물 세트(정본). */
const CANON_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
  { src: '/icons/icon-mono.svg', sizes: '512x512', purpose: 'monochrome' },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FR-CLIENT-03 PWA manifest', () => {
  it('FR-CLIENT-03 manifest가 standalone·start_url·scope와 정본 아이콘 세트를 갖고 일반 웹 접근과 설치 안내가 동작한다', async () => {
    // manifest 필드(TRD §6, 디자인 §9-3)
    expect(manifest).toMatchObject({ start_url: '/', scope: '/', display: 'standalone', lang: 'ko' });
    expect(manifest.name).toBe('Workspace');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    for (const name of [manifest.name, manifest.short_name]) expect(name).not.toMatch(/slack/i);
    expect(manifest.background_color).toBe(radixScales.light.slate[0]);
    expect(manifest.theme_color).toBe(radixScales.light.slate[1]);

    // 정본 아이콘 세트 — manifest 목록과 실제 파일 존재·크기 대조
    expect(manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose }))).toEqual(CANON_ICONS);
    for (const icon of CANON_ICONS) {
      const file = join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      if (file.endsWith('.png')) expect(pngSize(file), icon.src).toBe(icon.sizes);
      else expect(readFileSync(file, 'utf8')).toContain('viewBox="0 0 512 512"');
    }
    expect(pngSize(join(PUBLIC, 'icons/apple-touch-icon.png'))).toBe('180x180');
    expect(existsSync(join(PUBLIC, 'icons/favicon.svg'))).toBe(true);
    expect(existsSync(join(PUBLIC, 'favicon.ico'))).toBe(true);

    // index.html 연결(§9-2·§9-3)
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />');
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${radixScales.light.slate[1]}" />`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${radixScales.dark.slate[1]}" />`);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // CSP script-src 'self': 인라인 스크립트 없음

    // 일반 웹 접근: dev·SW 미지원 환경에서는 등록하지 않고 앱은 그대로 동작
    const register = vi.fn(() => Promise.resolve(undefined));
    expect(registerServiceWorker({ prod: false, navigator: { serviceWorker: { register } } })).toBe(false);
    expect(registerServiceWorker({ prod: true, navigator: {} })).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(registerServiceWorker({ prod: true, navigator: { serviceWorker: { register } } })).toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });

    // 설치 안내: 모드 판정
    expect(detectInstallMode({ standalone: true, canPrompt: true, userAgent: 'iPhone' })).toBe('standalone');
    expect(detectInstallMode({ standalone: false, canPrompt: true, userAgent: 'Chrome' })).toBe('prompt');
    expect(
      detectInstallMode({ standalone: false, canPrompt: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' }),
    ).toBe('ios');
    expect(detectInstallMode({ standalone: false, canPrompt: false, userAgent: 'Firefox' })).toBe('unsupported');

    // beforeinstallprompt 수신 → prompt 모드, install() 호출 시 브라우저 프롬프트 실행
    const prompt = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.mode).not.toBe('prompt');
    act(() => {
      const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(result.current.mode).toBe('prompt');
    await act(() => result.current.install());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.current.mode).not.toBe('prompt');

    // 정본 문구가 없으면 렌더하지 않는다(UI_STATES §8 Q-1). 문구가 주어지면 버튼이 프롬프트를 연다.
    const onInstall = vi.fn();
    const empty = render(createElement(InstallHint, { mode: 'prompt', onInstall }));
    expect(empty.container.innerHTML).toBe('');
    empty.unmount();
    const withCopy = render(createElement(InstallHint, { mode: 'prompt', onInstall, copy: { button: 'B' } }));
    withCopy.getByRole('button', { name: 'B' }).click();
    expect(onInstall).toHaveBeenCalledTimes(1);
    withCopy.unmount();
    const ios = render(createElement(InstallHint, { mode: 'ios', onInstall, copy: { ios: 'I' } }));
    expect(ios.getByText('I')).toBeTruthy();
    ios.unmount();
    expect(render(createElement(InstallHint, { mode: 'standalone', onInstall, copy: { button: 'B', ios: 'I' } })).container.innerHTML).toBe('');
  });
});
