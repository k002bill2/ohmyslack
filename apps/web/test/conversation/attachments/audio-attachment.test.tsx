/**
 * FR-OPS-05 보조 컴포넌트 테스트(DEV_DESIGN 6-2 — 정확한 경로). CMP-28 AudioAttachment(Jarvis ★ 임시 결정, Q-H2):
 * 오디오 준비(src = `/api/attachments/{id}`, 길이 m:ss) · 재생 실패 → 문구 + 「다시 시도」 · 만료 자리표시자(src 없음).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioAttachment, formatDuration } from '../../../src/features/conversation/attachments/index.js';
import { ATTACHMENT_COPY } from '../../../src/ui/copy.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

function audioEl(container: HTMLElement): HTMLAudioElement | null {
  return container.querySelector('audio');
}

describe('FR-OPS-05 CMP-28 AudioAttachment', () => {
  it('FR-OPS-05 준비: 네이티브 컨트롤 + preload none + src는 다운로드 경로 + 길이 m:ss', () => {
    const a = attachment({ duration_ms: 125_400 });
    const { container } = render(<AudioAttachment attachment={a} />);
    const audio = audioEl(container);
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe(`/api/attachments/${a.id}`);
    expect(audio?.hasAttribute('controls')).toBe(true);
    expect(audio?.getAttribute('preload')).toBe('none');
    expect(screen.getByText('2:05')).toBeTruthy();
  });

  it('FR-OPS-05 길이가 없으면 길이 텍스트를 그리지 않는다', () => {
    const { container } = render(<AudioAttachment attachment={attachment({ duration_ms: null })} />);
    expect(container.querySelector('.attachment-duration')).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(59_000)).toBe('0:59');
  });

  it('FR-OPS-05 재생 실패(error) → 「재생할 수 없습니다」 + 「다시 시도」(role=status), 다시 시도하면 같은 src로 플레이어를 다시 만든다', () => {
    const a = attachment();
    const { container } = render(<AudioAttachment attachment={a} />);
    fireEvent.error(audioEl(container) as HTMLAudioElement);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(ATTACHMENT_COPY.playbackFailed);
    expect(audioEl(container)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_COPY.retry }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(audioEl(container)?.getAttribute('src')).toBe(`/api/attachments/${a.id}`);
  });

  it('FR-OPS-05 만료(expired=true) → 「만료된 첨부입니다」 자리표시자, audio·src 없음(바이트 404 요청을 만들지 않는다)', () => {
    const { container } = render(<AudioAttachment attachment={attachment({ expired: true, duration_ms: 1000 })} />);
    expect(screen.getByText(ATTACHMENT_COPY.expired)).toBeTruthy();
    expect(audioEl(container)).toBeNull();
    expect(container.querySelector('[src]')).toBeNull();
  });
});
