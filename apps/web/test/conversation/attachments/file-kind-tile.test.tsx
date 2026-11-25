/**
 * 문서 형식 타일(doc-attach-card, UI_STATES §2-13): 확장자 글자·형식별 색 클래스·장식(aria-hidden)·확장성.
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FILE_TILE_LABEL_MAX,
  FILE_TILE_TONES,
  FileKindTile,
  fileTileLabel,
  type FileTileTone,
} from '../../../src/features/conversation/attachments/FileKindTile.js';
import { composerDocumentKind, documentFormat } from '../../../src/features/conversation/attachments/file-kinds.js';
import { tokens } from '../../../src/ui/tokens.js';
import { DOCUMENT_KIND_COPY, type DocumentKind } from '../../../src/ui/copy.js';

afterEach(cleanup);

const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/features/conversation/attachments/attachments.css'), 'utf8');
const KINDS = Object.keys(DOCUMENT_KIND_COPY) as DocumentKind[];

describe('FileKindTile', () => {
  it.each<[DocumentKind, string, string, FileTileTone]>([
    ['excel', 'xlsx', 'XLSX', 'green'],
    ['powerpoint', 'pptx', 'PPTX', 'orange'],
    ['pdf', 'pdf', 'PDF', 'red'],
    ['word', 'docx', 'DOCX', 'blue'],
    ['hwp', 'hwp', 'HWP', 'cyan'],
    ['txt', 'txt', 'TXT', 'neutral'],
    ['md', 'md', 'MD', 'neutral'],
    ['csv', 'csv', 'CSV', 'neutral'],
  ])('%s(%s) → 글자 %s, 색조 %s, aria-hidden', (kind, ext, label, tone) => {
    const { container } = render(<FileKindTile kind={kind} ext={ext} />);
    const tile = container.querySelector('.file-kind-tile') as HTMLElement;
    expect(tile.textContent).toBe(label);
    expect(tile.classList.contains(`file-tile-${tone}`)).toBe(true);
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.hasAttribute('style')).toBe(false);
    expect(tile.querySelector('.file-kind-tile-spinner')).toBeNull();
  });

  it('4자 초과 확장자는 앞 4자(대문자), 점은 떼어낸다', () => {
    expect(FILE_TILE_LABEL_MAX).toBe(4);
    expect(fileTileLabel('markdown')).toBe('MARK');
    expect(fileTileLabel('.hwpx')).toBe('HWPX');
    expect(fileTileLabel('docm')).toBe('DOCM');
    expect(fileTileLabel('')).toBe('');
  });

  it('busy면 타일 안에 장식 스피너, 글자는 그대로', () => {
    const { container } = render(<FileKindTile kind="pdf" ext="pdf" busy />);
    const tile = container.querySelector('.file-kind-tile') as HTMLElement;
    expect(tile.querySelector('.file-kind-tile-spinner')).not.toBeNull();
    expect(tile.textContent).toBe('PDF');
  });

  it('모든 형식에 색조가 있고, 색조마다 CSS 규칙과 라이트·다크 토큰 쌍이 있다(raw hex 없음)', () => {
    expect(Object.keys(FILE_TILE_TONES).sort()).toEqual([...KINDS].sort());
    for (const tone of new Set(Object.values(FILE_TILE_TONES))) {
      const rule = CSS.match(new RegExp(`\\.file-tile-${tone} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, tone).toContain(`background: var(--file-tile-${tone});`);
      expect(rule, tone).toContain(`color: var(--on-file-tile-${tone});`);
      for (const s of ['light', 'dark'] as const) {
        expect(tokens.colors[s][`--file-tile-${tone}`]?.role, `${s} ${tone}`).toBe('surface');
        expect(tokens.colors[s][`--on-file-tile-${tone}`]?.on, `${s} ${tone}`).toBe(`--file-tile-${tone}`);
      }
    }
    const tileCss = CSS.slice(CSS.indexOf('.file-kind-tile {'));
    expect(tileCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('움직임 줄이기: 스피너 회전 없음', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.file-kind-tile-spinner \{\s*animation: none;/);
  });

  it('형식 표·확장자에서 타일 입력을 얻는다(메시지 = 서버 mime, 작성기 = 파일명)', () => {
    expect(documentFormat('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toEqual({ kind: 'excel', ext: 'xlsx' });
    expect(documentFormat('application/hwp+zip')).toEqual({ kind: 'hwp', ext: 'hwpx' });
    expect(documentFormat('image/png')).toBeNull();
    expect(composerDocumentKind('보고서.PPTM')).toBe('powerpoint');
    expect(composerDocumentKind('a.png')).toBeNull();
  });

  it('확장성: 새 형식은 색조 표 한 줄 — 빠지면 타입 오류, 넣으면 그대로 렌더', () => {
    type FakeKind = DocumentKind | 'fake';
    // @ts-expect-error 새 형식('fake')의 색조 줄이 빠지면 Record가 타입 오류로 막는다.
    const missing: Record<FakeKind, FileTileTone> = { ...FILE_TILE_TONES };
    const extended: Record<FakeKind, FileTileTone> = { ...FILE_TILE_TONES, fake: 'blue' };
    expect(missing).toBeDefined();
    expect(extended.fake).toBe('blue');
    // 런타임: 타일은 표 조회만 하므로 표에 한 줄 넣은 형식도 같은 경로로 그린다.
    const { container } = render(<FileKindTile kind={'word' satisfies DocumentKind} ext="fakefmt" />);
    expect(container.querySelector('.file-kind-tile')?.textContent).toBe('FAKE');
  });
});
