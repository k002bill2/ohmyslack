/**
 * QA iPhone r2(2026-11-14) 문서 「받기」 링크 — W2 파일명 단일 출처(서버 Content-Disposition).
 * 참고 출처: 일반 관념, 저장소 내부 문서.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import { AttachmentList } from '../../../src/features/conversation/attachments/index.js';
import { attachment } from './fixtures.js';

afterEach(cleanup);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const doc = (over: Partial<AttachmentView> = {}) => attachment({ mime: DOCX, byte_size: 2048, filename: '분기 보고서.docx', has_macros: false, ...over });
const link = (c: HTMLElement) => c.querySelector('a.doc-download') as HTMLAnchorElement;

describe('W2 「받기」 파일명은 서버 헤더가 정한다', () => {
  it('download 속성은 값 없이 둔다(브라우저가 Content-Disposition 파일명을 쓴다)', () => {
    const { container } = render(<AttachmentList attachments={[doc({ filename: `${'가'.repeat(89)}.docm` })]} />);
    expect(link(container).hasAttribute('download')).toBe(true);
    expect(link(container).getAttribute('download')).toBe('');
  });
});
