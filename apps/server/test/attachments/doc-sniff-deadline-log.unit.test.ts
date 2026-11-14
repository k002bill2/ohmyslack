import { describe, expect, it, vi } from 'vitest';
import type { AttachmentsStore } from '../../src/modules/attachments/repo.js';
import { createAttachmentsService } from '../../src/modules/attachments/service.js';
import type { ConversationsService } from '../../src/modules/conversations/service.js';
import { createOpsLogger } from '../../src/modules/ops/logger.js';
import { buildZip, docxEntries } from './fixtures/zip-builder.js';

/** TRD §6-1-1 (2): 벽시계 보조 상한 초과 → 415 + ops 로그 `sniff_deadline`(본문·파일명 미기록, B6). */
describe('판정 deadline ops 로그', () => {
  const FILENAME = 'canary-deadline-보고서.docx';

  function setup(step: number) {
    const lines: string[] = [];
    const insert = vi.fn();
    let t = 0;
    const service = createAttachmentsService({
      store: { insert } as unknown as AttachmentsStore,
      conversations: {} as ConversationsService,
      clock: () => 0,
      sniffClock: () => (t += step),
      logger: createOpsLogger((line) => lines.push(line)),
    });
    return { service, lines, insert };
  }

  it('가짜 시계가 deadline을 넘기면 415이고 sniff_deadline 한 줄만 남으며 파일명·본문은 없다', async () => {
    const { service, lines, insert } = setup(10_000);
    const bytes = buildZip(docxEntries());
    await expect(service.upload('u1', 'c1', 'application/octet-stream', bytes, encodeURIComponent(FILENAME))).rejects.toMatchObject({
      statusCode: 415,
      code: 'unsupported_media_type',
    });
    expect(insert).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ event: 'attachment_sniff_deadline', error_code: 'sniff_deadline' });
    expect(lines.join('\n')).not.toContain('canary');
  });

  it('deadline 안이면 deadline 로그를 남기지 않는다', async () => {
    const { service, lines, insert } = setup(0);
    insert.mockResolvedValue({});
    await service.upload('u1', 'c1', 'application/octet-stream', buildZip(docxEntries()), encodeURIComponent(FILENAME));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });
});
