/** 첨부 초안 저장소 단위 테스트 — React 없이 저장소를 직접 구동하고, 업로드는 수동으로 풀어 주는 지연 객체를 쓴다. */
import { describe, expect, it } from 'vitest';
import type { AttachmentView } from '../../../../../packages/shared/src/index.js';
import type { ActionResult } from '../../../src/data/index.js';
import { createAttachmentDraftStore, type UploadFn } from '../../../src/features/conversation/attachments/attachment-drafts.js';
import { attachment } from './fixtures.js';

type Result = ActionResult<AttachmentView>;

interface Call {
  readonly name: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (r: Result) => void;
  readonly reject: (e: unknown) => void;
}

function harness() {
  const calls: Call[] = [];
  const upload: UploadFn = (file, options) =>
    new Promise<Result>((resolve, reject) => {
      calls.push({ name: file.name, signal: options?.signal, resolve, reject });
    });
  return { calls, upload, store: createAttachmentDraftStore() };
}

const file = (name: string) => new File(['x'], name, { type: 'image/png' });
const flush = () => Promise.resolve().then(() => undefined);
const okResult = (id: string): Result => ({ ok: true, value: attachment({ id }) }) as Result;
const failResult = (status: number): Result => ({ ok: false, status }) as Result;

describe('첨부 초안 저장소 — 늦은 응답·재시도', () => {
  it('업로드 중인 칩에 retry를 불러도 새 요청이 시작되지 않는다', () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png')], upload);
    const [chip] = store.chips('c1');
    store.retry('c1', chip!.key, upload);
    expect(calls).toHaveLength(1);
    expect(store.chips('c1')[0]?.status).toBe('uploading');
  });

  it('완료·재시도 불가 칩에도 retry는 아무것도 하지 않는다', async () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png'), file('b.png')], upload);
    calls[0]!.resolve(okResult('11111111-1111-4111-8111-111111111111'));
    calls[1]!.resolve(failResult(413));
    await flush();
    const [done, blocked] = store.chips('c1');
    expect(done?.status).toBe('done');
    expect(blocked?.retryable).toBe(false);
    store.retry('c1', done!.key, upload);
    store.retry('c1', blocked!.key, upload);
    expect(calls).toHaveLength(2);
  });

  it('실패 칩을 retry한 뒤 이전 요청의 성공이 늦게 와도 새 요청의 실패 문구가 유지된다', async () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png')], upload);
    const key = store.chips('c1')[0]!.key;
    calls[0]!.resolve(failResult(500));
    await flush();
    store.retry('c1', key, upload);
    expect(calls).toHaveLength(2);
    // 재시도 요청이 먼저 실패한 뒤 이전 요청의 응답이 늦게 도착
    calls[1]!.resolve(failResult(503));
    await flush();
    const failed = store.chips('c1')[0]!;
    expect(failed.status).toBe('failed');
    const text = failed.error;
    calls[0]!.resolve(okResult('22222222-2222-4222-8222-222222222222'));
    await flush();
    expect(store.chips('c1')[0]).toMatchObject({ status: 'failed', error: text });
    expect(store.chips('c1')[0]?.attachmentId).toBeUndefined();
  });

  it('retry 뒤 이전 요청의 실패가 늦게 와도 새 요청의 완료 ID가 유지된다', async () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png')], upload);
    const key = store.chips('c1')[0]!.key;
    calls[0]!.resolve(failResult(500));
    await flush();
    store.retry('c1', key, upload);
    // 이전 요청(0번)은 이미 응답했으므로, 재시도 중 한 번 더 실패→재시도로 겹침을 만든다.
    calls[1]!.resolve(failResult(500));
    await flush();
    store.retry('c1', key, upload);
    expect(calls).toHaveLength(3);
    const id = '33333333-3333-4333-8333-333333333333';
    calls[2]!.resolve(okResult(id));
    await flush();
    expect(store.chips('c1')[0]).toMatchObject({ status: 'done', attachmentId: id });
    calls[1]!.reject(new Error('late'));
    await flush();
    expect(store.chips('c1')[0]).toMatchObject({ status: 'done', attachmentId: id });
  });

  it('discard 뒤 같은 키로 새 칩을 넣어도 폐기된 요청의 늦은 응답이 새 칩을 바꾸지 않는다', async () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png')], upload);
    store.discard('c1');
    expect(calls[0]!.signal?.aborted).toBe(true);
    store.add('c1', [file('b.png')], upload);
    calls[0]!.resolve(okResult('44444444-4444-4444-8444-444444444444'));
    await flush();
    expect(store.chips('c1')).toHaveLength(1);
    expect(store.chips('c1')[0]).toMatchObject({ status: 'uploading' });
    expect(store.chips('c1')[0]?.attachmentId).toBeUndefined();
  });

  it('제거된 칩의 늦은 응답 뒤에도 대기 중이던 세 번째 업로드가 시작된다', async () => {
    const { calls, upload, store } = harness();
    store.add('c1', [file('a.png'), file('b.png'), file('c.png')], upload);
    expect(calls).toHaveLength(2);
    store.remove('c1', store.chips('c1')[0]!.key);
    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[0]!.resolve(okResult('55555555-5555-4555-8555-555555555555'));
    await flush();
    expect(calls.map((c) => c.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(store.chips('c1').map((c) => c.status)).toEqual(['uploading', 'uploading']);
  });
});
