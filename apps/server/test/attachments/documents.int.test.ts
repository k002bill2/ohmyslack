import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/auth/routes.js';
import { ATTACHMENT_FILENAME_HEADER } from '../../src/shared.js';
import type { Session } from '../auth/members-int-harness.js';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { HOST, ORIGIN } from '../support/auth-app.js';
import { counts, HTML, png } from './att-harness.js';
import { buildOle, docTree, encryptedTree, hwpTree, oleStream, pptTree, xlsTree } from './fixtures/ole-builder.js';
import { buildZip, docxEntries, hwpxEntries, pptxEntries, xlsxEntries } from './fixtures/zip-builder.js';

/** FR-OPS-09 지정 테스트(DEV_DESIGN 6-6, 정본: TRD §3 415 하위 코드·§6-1-1 (1)·(3)·(4)). 픽스처는 모두 합성 바이트. */
let ctx: ConvIntContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

const OCTET = 'application/octet-stream';
const pdf = (): Buffer => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

function docUpload(app: FastifyInstance, session: Session, conversationId: string, bytes: Buffer, filename: string, contentType = OCTET): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/attachments?conversation_id=${conversationId}`,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${session.token}`,
      'x-csrf-token': session.csrf,
      'content-type': contentType,
      [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(filename),
    },
    payload: bytes,
  });
}

interface Accepted {
  readonly bytes: Buffer;
  readonly name: string;
  readonly mime: string;
  readonly hasMacros: boolean;
  readonly declared?: string;
}

interface Rejected {
  readonly label: string;
  readonly bytes: Buffer;
  readonly name: string;
  readonly code: string;
  readonly declared?: string;
}

const ACCEPTED: readonly Accepted[] = [
  { bytes: pdf(), name: 'report.pdf', mime: 'application/pdf', hasMacros: false, declared: 'application/pdf' },
  { bytes: buildZip(docxEntries()), name: 'memo.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hasMacros: false },
  { bytes: buildZip(xlsxEntries()), name: 'sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hasMacros: false },
  { bytes: buildZip(pptxEntries()), name: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hasMacros: false },
  { bytes: buildZip(hwpxEntries()), name: '문서.hwpx', mime: 'application/hwp+zip', hasMacros: false },
  { bytes: buildOle(hwpTree()), name: '문서.hwp', mime: 'application/x-hwp', hasMacros: false },
  { bytes: buildOle(docTree()), name: 'old.doc', mime: 'application/msword', hasMacros: false, declared: 'application/msword' },
  // .xls·.ppt는 목록만으로 매크로 부재를 증명할 수 없어 항상 true(TRD §6-1-1 (3) 보수 표시).
  { bytes: buildOle(xlsTree()), name: 'old.xls', mime: 'application/vnd.ms-excel', hasMacros: true },
  { bytes: buildOle(pptTree()), name: 'old.ppt', mime: 'application/vnd.ms-powerpoint', hasMacros: true },
  // 매크로 OOXML은 macroEnabled MIME·.docm, 매크로 없는 OOXML의 m 확장자는 원래 확장자 유지.
  { bytes: buildZip(docxEntries([{ name: 'word/vbaProject.bin', data: Buffer.from('vba') }])), name: 'macro.docm', mime: 'application/vnd.ms-word.document.macroEnabled.12', hasMacros: true },
  { bytes: buildZip(xlsxEntries()), name: 'plain.xlsm', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hasMacros: false },
  // 텍스트 계열 3종: 이진 판정 0개 + UTF-8 + 확장자로 MIME 확정.
  { bytes: Buffer.from('안녕\n'), name: 'note.txt', mime: 'text/plain', hasMacros: false, declared: 'text/plain; charset=utf-8' },
  { bytes: Buffer.from('# 제목\n'), name: 'readme.md', mime: 'text/markdown', hasMacros: false },
  { bytes: Buffer.from('﻿a,b\n1,2\n'), name: 'table.csv', mime: 'text/csv', hasMacros: false },
];

const encryptedZip = buildZip(docxEntries([{ name: 'word/secret.xml', data: Buffer.from('x'), flags: 1 }]));

const REJECTED: readonly Rejected[] = [
  // 허용목록 밖: 이진 일치 0 + 텍스트 아님, 텍스트인데 확장자 밖(.html은 extension_mismatch가 아님), ZIP·OLE인데 알려진 형식 아님, 선언 MIME 불일치.
  { label: 'binary', bytes: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]), name: 'blob.bin', code: 'unsupported_media_type' },
  { label: 'html', bytes: HTML, name: 'page.html', code: 'unsupported_media_type' },
  { label: 'zip', bytes: buildZip([{ name: 'readme.txt', data: Buffer.from('x') }]), name: 'archive.docx', code: 'unsupported_media_type' },
  { label: 'excel5', bytes: buildOle([oleStream('Book')]), name: 'old.xls', code: 'unsupported_media_type' },
  { label: 'declared', bytes: pdf(), name: 'report.pdf', code: 'unsupported_media_type', declared: 'image/png' },
  // 다중 형식 일치(폴리글랏): OOXML 두 부분 동시, PDF 뒤 ZIP, OLE 두 스트림 동시. 미디어(PNG)를 문서로 선언·명명해도 415.
  { label: 'ooxml-two', bytes: buildZip(docxEntries([{ name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') }])), name: 'both.docx', code: 'unsupported_media_type' },
  { label: 'pdf-zip', bytes: buildZip(docxEntries(), { prefix: pdf() }), name: 'both.pdf', code: 'unsupported_media_type' },
  { label: 'ole-two', bytes: buildOle([...docTree(), ...xlsTree()]), name: 'both.doc', code: 'unsupported_media_type' },
  { label: 'png-as-doc', bytes: png(), name: 'image.pdf', code: 'unsupported_media_type' },
  // 암호화: ZIP 일반 목적 비트 0, OLE EncryptionInfo·EncryptedPackage.
  { label: 'zip-encrypted', bytes: encryptedZip, name: 'locked.docx', code: 'encrypted_document' },
  { label: 'ole-encrypted', bytes: buildOle(encryptedTree()), name: 'locked.docx', code: 'encrypted_document' },
  // 확장자 불일치: 형식과 다른 확장자, 매크로 OOXML이 x 확장자.
  { label: 'docx-as-pdf', bytes: buildZip(docxEntries()), name: 'memo.pdf', code: 'extension_mismatch' },
  { label: 'pdf-as-txt', bytes: pdf(), name: 'report.txt', code: 'extension_mismatch' },
  { label: 'hwp-as-doc', bytes: buildOle(hwpTree()), name: '문서.doc', code: 'extension_mismatch' },
  { label: 'docm-as-docx', bytes: buildZip(docxEntries([{ name: 'word/vbaProject.bin', data: Buffer.from('vba') }])), name: 'macro.docx', code: 'macro_extension_mismatch' },
];

describe('문서 첨부(FR-OPS-09)', () => {
  it('FR-OPS-09 허용 문서 9종은 내용으로 판정해 저장하고 허용목록 밖·다중 형식 일치·암호화·확장자 불일치는 415로 저장되지 않는다', async () => {
    ctx = await setupConvInt();
    const c = ctx;
    const a = await as(c.app, 'a');
    const channel = await createChannel(c.app, a, 'docs');

    // 1) 415: 하위 코드는 처음 걸린 사유 하나, 행·바이트 저장 0.
    const before = await counts(c.schema);
    for (const r of REJECTED) {
      const res = await docUpload(c.app, a, channel, r.bytes, r.name, r.declared);
      expect(res.statusCode, r.label).toBe(415);
      expect(res.json<{ error: { code: string } }>().error.code, r.label).toBe(r.code);
    }
    expect(await counts(c.schema)).toEqual(before);
    expect(before).toEqual({ meta: 0, blobs: 0 });

    // 2) 허용 9종 + 매크로 OOXML + 텍스트 3종: 201, 판정 MIME·정규 파일명·has_macros, 바이트 저장.
    for (const ok of ACCEPTED) {
      const res = await docUpload(c.app, a, channel, ok.bytes, ok.name, ok.declared);
      expect(res.statusCode, `${ok.name} ${res.body}`).toBe(201);
      const body = res.json<{ attachment_id: string; attachment: Record<string, unknown> }>();
      expect(body.attachment, ok.name).toMatchObject({ mime: ok.mime, filename: ok.name, has_macros: ok.hasMacros, byte_size: ok.bytes.length, expired: false });
      const row = await c.schema.pool.query<{ mime: string; filename: string; has_macros: boolean }>('SELECT mime, filename, has_macros FROM attachments WHERE id = $1', [
        body.attachment_id,
      ]);
      expect(row.rows[0], ok.name).toEqual({ mime: ok.mime, filename: ok.name, has_macros: ok.hasMacros });
    }
    expect(await counts(c.schema)).toEqual({ meta: ACCEPTED.length, blobs: ACCEPTED.length });
    const distinctDocMimes = new Set(ACCEPTED.filter((x) => !x.mime.startsWith('text/') && !x.mime.includes('macroEnabled')).map((x) => x.mime));
    expect(distinctDocMimes.size).toBe(9);
  });
});
