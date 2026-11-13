import { DOC_ZIP_EOCD_SCAN_BYTES, type AttachmentFileMime } from '../../shared.js';
import { reject, type SniffBudget } from './doc-budget.js';
import { listOle, readOleStreamPrefix, rootChildren, type OleListing } from './ole-list.js';
import { MEDIA_SNIFFERS, type Sniffed } from './sniff.js';
import { listZip, readStoredPrefix, type ZipListing } from './zip-list.js';

/**
 * 문서·텍스트 판정 공통 진입점(정본: TRD §6-1-1 (1)·(3)·(4), B10). 이진 판정기 13종(미디어 4 + 문서 9)을 모두 돌려
 * **정확히 하나**만 일치해야 한다(폴리글랏 차단). 0개면 텍스트 판정(UTF-8·NUL 0·확장자 txt/md/csv).
 * 압축 해제·XML 파싱·변환은 0 — ZIP·OLE는 목록과 고정 길이 두 곳만 읽는다.
 */
export type DocMatch =
  | { readonly kind: 'media'; readonly media: Sniffed }
  | {
      readonly kind: 'file';
      readonly mime: AttachmentFileMime;
      /** 허용 확장자(소문자). 첫 번째가 정규형. */
      readonly extensions: readonly string[];
      readonly hasMacros: boolean;
      /** 매크로 OOXML이 x 확장자로 오면 macro_extension_mismatch(TRD §3). */
      readonly macroOoxml: boolean;
    };

type FileMatch = Extract<DocMatch, { kind: 'file' }>;

const file = (mime: AttachmentFileMime, extensions: readonly string[], hasMacros: boolean, macroOoxml = false): FileMatch => ({
  kind: 'file',
  mime,
  extensions,
  hasMacros,
  macroOoxml,
});

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function matchPdf(b: Buffer): FileMatch | undefined {
  if (b.length < PDF_MAGIC.length || !b.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return undefined;
  // PDF + ZIP 이중 해석 차단: 끝 65,557바이트 안에 EOCD 서명이 있으면 415.
  if (b.subarray(Math.max(0, b.length - DOC_ZIP_EOCD_SCAN_BYTES)).includes(EOCD_SIG)) throw reject('pdf_zip_polyglot');
  return file('application/pdf', ['pdf'], false);
}

interface OoxmlKind {
  readonly part: string;
  readonly mime: AttachmentFileMime;
  readonly macroMime: AttachmentFileMime;
  readonly ext: string;
}

const OOXML: readonly OoxmlKind[] = [
  {
    part: 'word/document.xml',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    macroMime: 'application/vnd.ms-word.document.macroEnabled.12',
    ext: 'doc',
  },
  {
    part: 'xl/workbook.xml',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    macroMime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    ext: 'xls',
  },
  {
    part: 'ppt/presentation.xml',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    macroMime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    ext: 'ppt',
  },
];

const HWPX_MIMETYPE = 'application/hwp+zip';

export function ooxmlHasMacros(names: readonly string[]): boolean {
  return names.some((n) => n.toLowerCase().endsWith('vbaproject.bin') || n.toLowerCase().startsWith('xl/macrosheets/'));
}

function matchZip(b: Buffer, listing: ZipListing): FileMatch[] {
  const names = listing.entries.map((e) => e.name);
  const has = new Set(names);
  const out: FileMatch[] = [];
  const macros = ooxmlHasMacros(names);
  if (has.has('[Content_Types].xml')) {
    for (const k of OOXML) {
      if (!has.has(k.part)) continue;
      out.push(macros ? file(k.macroMime, [`${k.ext}m`], true, true) : file(k.mime, [`${k.ext}x`, `${k.ext}m`], false));
    }
  }
  const first = listing.entries[0];
  if (first !== undefined && first.name === 'mimetype' && first.method === 0 && first.compressedSize === HWPX_MIMETYPE.length) {
    const content = readStoredPrefix(b, first, HWPX_MIMETYPE.length);
    if (content?.toString('latin1') === HWPX_MIMETYPE && has.has('Contents/content.hpf')) {
      out.push(file('application/hwp+zip', ['hwpx'], names.some((n) => n.startsWith('Scripts/'))));
    }
  }
  return out;
}

const OLE_MACRO_NAMES = new Set(['MACROS', '_VBA_PROJECT_CUR', 'VBA']);
const HWP_SIGNATURE = 'HWP Document File';

function matchOle(b: Buffer, listing: OleListing, budget: SniffBudget): FileMatch[] {
  const root = rootChildren(listing);
  const child = (name: string, type: 'stream' | 'storage') => root.find((e) => e.name === name && e.type === type);
  const vba = listing.entries.some((e) => e.type === 'storage' && OLE_MACRO_NAMES.has(e.name.toUpperCase()));
  const out: FileMatch[] = [];
  const header = child('FileHeader', 'stream');
  if (header !== undefined && child('DocInfo', 'stream') !== undefined && child('BodyText', 'storage') !== undefined) {
    const prefix = readOleStreamPrefix(b, listing, header, 32, budget);
    if (prefix.toString('latin1', 0, HWP_SIGNATURE.length) === HWP_SIGNATURE) {
      out.push(file('application/x-hwp', ['hwp'], vba || child('Scripts', 'storage') !== undefined));
    }
  }
  if (child('WordDocument', 'stream') !== undefined) out.push(file('application/msword', ['doc'], vba));
  // .xls·.ppt는 목록만으로 매크로 부재를 증명할 수 없어 항상 true(TRD §6-1-1 (3) ★ 보수 표시).
  if (child('Workbook', 'stream') !== undefined) out.push(file('application/vnd.ms-excel', ['xls'], true));
  if (child('PowerPoint Document', 'stream') !== undefined) out.push(file('application/vnd.ms-powerpoint', ['ppt'], true));
  return out;
}

/** 이진 판정기 13종의 일치 목록. 컨테이너 규칙 위반은 DocSniffError(→ 415). */
export function binaryMatches(b: Buffer, budget: SniffBudget): DocMatch[] {
  const matches: DocMatch[] = [];
  for (const sniffer of MEDIA_SNIFFERS) {
    const media = sniffer(b);
    if (media !== undefined) matches.push({ kind: 'media', media });
  }
  const pdf = matchPdf(b);
  if (pdf !== undefined) matches.push(pdf);
  const zip = listZip(b, budget);
  if (zip !== undefined) matches.push(...matchZip(b, zip));
  const ole = listOle(b, budget);
  if (ole !== undefined) matches.push(...matchOle(b, ole, budget));
  return matches;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const TEXT_KINDS: Readonly<Record<string, AttachmentFileMime>> = Object.freeze({ txt: 'text/plain', md: 'text/markdown', csv: 'text/csv' });

/** 텍스트 판정 ①②: 유효 UTF-8(BOM 허용, 잘린·과장·서로게이트 실패) + NUL 0. */
export function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0x00)) return false;
  try {
    STRICT_UTF8.decode(b);
    return true;
  } catch {
    return false;
  }
}

/**
 * 판정(TRD §6-1-1 (4) 판정 단계). `ext`는 원 파일명의 마지막 확장자(소문자, 없으면 '' — 텍스트 계열은 확장자로 MIME 확정).
 * 반환은 정확히 하나의 형식. 실패는 DocSniffError.
 */
export function classify(b: Buffer, ext: string, budget: SniffBudget): DocMatch {
  const matches = binaryMatches(b, budget);
  if (matches.length > 1) throw reject('polyglot');
  const [only] = matches;
  if (only !== undefined) return only;
  if (!isUtf8Text(b)) throw reject('no_match');
  const mime = TEXT_KINDS[ext];
  if (mime === undefined) throw reject('text_extension');
  return file(mime, [ext], false);
}

export type ExtensionCheck = { readonly ok: true; readonly ext: string } | { readonly ok: false; readonly code: 'extension_mismatch' | 'macro_extension_mismatch' };

/** 확장자-형식 일치(TRD §6-1-1 (1)·(4) 마지막 415 단계). 통과하면 저장 확장자(소문자 정규형). */
export function checkExtension(match: FileMatch, ext: string): ExtensionCheck {
  if (match.extensions.includes(ext)) return { ok: true, ext };
  // 매크로 감지 OOXML이 .docx/.xlsx/.pptx로 오면 전용 코드(ADR-002 §4-3-1).
  if (match.macroOoxml && match.extensions.some((e) => `${e.slice(0, -1)}x` === ext)) return { ok: false, code: 'macro_extension_mismatch' };
  return { ok: false, code: 'extension_mismatch' };
}
