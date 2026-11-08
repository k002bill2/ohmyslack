/**
 * W-22 첨부 경로 B7·FR-CLIENT-04 회귀: SW는 `/api/attachments/**`를 우회(Range 포함), 업로드는 원시 바이트 + CSRF,
 * 메시지 생성에 `attachment_ids` 결속, 첨부 바이트·URL이 localStorage·sessionStorage·Cache Storage에 남지 않는다.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSwHandlers, routeRequest } from '../../../src/features/pwa';
import { CONV, ME, flush, message, setup } from '../../sync/fake-server.js';
import { fakeCacheStorage, fakeLifecycle, fetchEvent, request } from '../../pwa/fakes.js';
import { attachment } from './fixtures.js';

const ORIGIN = 'https://app.test';

describe('SW: 첨부 경로 우회', () => {
  it('GET /api/attachments/{id}(Range·navigate 포함)는 bypass, respondWith·캐시 없음', async () => {
    const shell = new Set(['/index.html']);
    const id = attachment().id;
    expect(routeRequest(request(`/api/attachments/${id}`), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest({ ...request(`/api/attachments/${id}`), headers: new Headers({ Range: 'bytes=0-' }) }, ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request(`/api/attachments/${id}`, { mode: 'navigate' }), ORIGIN, shell)).toBe('bypass');
    expect(routeRequest(request(`/api/attachments?conversation_id=${CONV}`, { method: 'POST' }), ORIGIN, shell)).toBe('bypass');
    const { storage, stores } = fakeCacheStorage();
    const fetcher = vi.fn(async () => new Response('x'));
    const sw = createSwHandlers({ storage, lifecycle: fakeLifecycle(), fetcher, entries: [], origin: ORIGIN });
    const ev = fetchEvent(request(`/api/attachments/${id}`));
    sw.onFetch(ev);
    expect(ev.respondWith).not.toHaveBeenCalled();
    expect([...stores.values()].every((s) => s.size === 0)).toBe(true);
  });
});

describe('http-source: 업로드·결속', () => {
  it('업로드는 원시 바이트 + Content-Type + X-CSRF-Token, 전송 body에 attachment_ids, 저장소에 첨부 흔적 없음', async () => {
    const { server, ds, storage } = setup();
    const a = attachment({ mime: 'image/png' });
    let uploadInit: RequestInit | undefined;
    server.on('POST /api/attachments', (_u, init) => {
      uploadInit = init;
      return { status: 201, body: { attachment_id: a.id, attachment: a } };
    });
    let posted: Record<string, unknown> | undefined;
    server.on(`POST /api/conversations/${CONV}/messages`, (_u, init) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { status: 201, body: { change_id: 1, message: { ...message(1, { author_id: ME, client_message_id: posted.client_message_id, body: posted.body }), author_kind: 'human', attachments: [a] } } };
    });
    ds.open?.(CONV);
    await ds.resume?.();
    for (let i = 0; i < 4; i += 1) await flush();

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' });
    const r = await ds.uploadAttachment?.(CONV, file);
    expect(r).toEqual({ ok: true, value: a });
    expect(server.log).toContain(`POST /api/attachments?conversation_id=${CONV}`);
    const headers = uploadInit?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['X-CSRF-Token']).toBe('csrf-1');
    expect(uploadInit?.body).toBe(file);

    ds.send({ conversationId: CONV }, '[이미지]', undefined, [a.id]);
    for (let i = 0; i < 4; i += 1) await flush();
    expect(posted?.attachment_ids).toEqual([a.id]);
    expect(ds.getSnapshot().messages.find((m) => m.body === '[이미지]')?.attachments).toEqual([a]);

    const persisted = JSON.stringify(storage) + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(persisted).not.toContain(a.id);
    expect(persisted).not.toContain('/api/attachments');
  });

  it('413·415 응답은 상태 코드로 돌려준다(문구 분기는 Composer)', async () => {
    const { server, ds } = setup();
    for (const status of [413, 415]) {
      server.on('POST /api/attachments', () => ({ status, body: { error: { code: status === 413 ? 'too_large' : 'unsupported_type' } } }));
      const r = await ds.uploadAttachment?.(CONV, new File(['x'], 'a.png', { type: 'image/png' }));
      expect(r?.ok).toBe(false);
      expect(r && !r.ok ? r.status : null).toBe(status);
    }
  });
});
