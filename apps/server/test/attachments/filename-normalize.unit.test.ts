import { describe, expect, it } from 'vitest';
import { asciiFallback, attachmentDisposition, decodeFilenameHeader, finalizeFilename, parseFilename } from '../../src/modules/attachments/filename.js';
import { ATTACHMENT_FILENAME_HEADER_MAX_BYTES, ATTACHMENT_FILENAME_MAX_BYTES, ATTACHMENT_FILENAME_MAX_CHARS } from '../../src/shared.js';

/** 파일명 정규화(정본: TRD §6-1-1 (5) ①–⑧)와 다운로드 헤더(§6-1-1 (6)). */
const norm = (raw: string, ext: string): string => {
  const decoded = decodeFilenameHeader(raw);
  if (decoded === undefined) throw new Error('decode');
  return finalizeFilename(parseFilename(decoded).stem, ext);
};

describe('filename normalize', () => {
  it('① 퍼센트 디코드: 유효 UTF-8만, 잘못된 인코딩·상한 초과·비 ASCII 원문은 거부', () => {
    expect(decodeFilenameHeader(encodeURIComponent('보고서.pdf'))).toBe('보고서.pdf');
    expect(decodeFilenameHeader('%FF%FE.pdf')).toBeUndefined();
    expect(decodeFilenameHeader('%E3%81.pdf')).toBeUndefined();
    expect(decodeFilenameHeader('%G1.pdf')).toBeUndefined();
    expect(decodeFilenameHeader('보고서.pdf')).toBeUndefined();
    expect(decodeFilenameHeader('a'.repeat(ATTACHMENT_FILENAME_HEADER_MAX_BYTES + 1))).toBeUndefined();
  });

  it('② NFC ③ basename ⑥ 확장자 소문자 정규형', () => {
    expect(norm(encodeURIComponent('C:\\Users\\x/../보고서.PDF'), 'pdf')).toBe('보고서.pdf');
    const nfd = '한'.normalize('NFD');
    expect(norm(encodeURIComponent(`${nfd}.txt`), 'txt')).toBe('한.txt');
  });

  it('④ C0·DEL·C1·양방향 제어(RTLO 포함) 제거, ⑤ 앞뒤 공백·점 제거', () => {
    const raw = encodeURIComponent(' ..a\r\nb\u0000c\u007f\u0085\u202Etxt.exe\u2066.. .pdf');
    const out = norm(raw, 'pdf');
    expect(out).toBe('abctxt.exe.pdf');
// eslint-disable-next-line no-control-regex -- 제어문자 제거·검사가 목적(TRD §6-1-1 (5) ④)
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(parseFilename('noext').ext).toBe('');
    expect(parseFilename('.hidden').ext).toBe('');
  });

  it('⑦ code point 경계에서 ≤ 200자·≤ 255바이트, ⑧ 빈 줄기는 document', () => {
    const long = norm(encodeURIComponent(`${'가'.repeat(110)}.docx`), 'docx');
    expect([...long].length).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_CHARS);
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_BYTES);
    expect(long.endsWith('.docx')).toBe(true);
    const ascii = norm(`${'a'.repeat(400)}.pdf`, 'pdf');
    expect([...ascii].length).toBe(ATTACHMENT_FILENAME_MAX_CHARS);
    expect(norm(encodeURIComponent('😀'.repeat(80) + '.md'), 'md')).toMatch(/^(😀)+\.md$/u);
    expect(finalizeFilename(parseFilename('\u202E . ').stem, 'pdf')).toBe('document.pdf');
  });

  it('Content-Disposition: attachment + ASCII 대체 + RFC 5987, CR·LF·따옴표 주입 0', () => {
    const header = attachmentDisposition('보고서 "1";%\\.pdf');
    expect(header).toBe(`attachment; filename="___ _1____.pdf"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20%221%22%3B%25%5C.pdf`);
    expect(asciiFallback('a\r\nb')).toBe('a__b');
    expect(attachmentDisposition('x\r\nSet-Cookie: a=b.txt')).not.toMatch(/[\r\n]/u);
  });
});
