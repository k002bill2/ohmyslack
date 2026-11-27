/** fake-server의 send/edit 응답이 shared `messageWriteResponseSchema`에 묶여 있는지(웹↔서버 계약). */
import { describe, expect, it } from 'vitest';
import { messageWriteResponseSchema } from '../../../../packages/shared/src/messages.js';
import { CONV, checkWriteContract, message } from './fake-server';

const SEND = `POST /api/conversations/${CONV}/messages`;
const EDIT = `PATCH /api/messages/${message(1).id}`;
const omit = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const ok = () => ({ message: message(1), seq: 1, change_id: 1, mention_user_ids: [] });

describe('fake-server 메시지 write 응답 계약', () => {
  it('기본 픽스처 message()로 만든 응답은 shared 스키마를 통과한다', () => {
    expect(() => messageWriteResponseSchema.parse(ok())).not.toThrow();
    expect(checkWriteContract(SEND, { status: 201, body: ok() })).toBeNull();
    expect(checkWriteContract(SEND, { status: 200, body: ok() })).toBeNull();
    expect(checkWriteContract(EDIT, { status: 200, body: ok() })).toBeNull();
  });

  it('필드가 빠지거나 이름이 바뀐 send/edit 2xx 응답은 위반으로 잡힌다', () => {
    expect(checkWriteContract(SEND, { status: 201, body: omit(ok(), 'change_id') })).toContain('change_id');
    expect(checkWriteContract(EDIT, { status: 200, body: { ...ok(), message: omit(message(1), 'author_kind') } })).toContain('author_kind');
    const { seq, ...rest } = ok();
    expect(checkWriteContract(SEND, { status: 201, body: { ...rest, sequence: seq } })).toContain('seq');
  });

  it('오류 응답과 write가 아닌 경로는 검사하지 않는다', () => {
    expect(checkWriteContract(SEND, { status: 500 })).toBeNull();
    expect(checkWriteContract(`DELETE /api/messages/${message(1).id}`, { status: 200, body: {} })).toBeNull();
    expect(checkWriteContract(`GET /api/conversations/${CONV}/messages`, { status: 200, body: {} })).toBeNull();
    expect(checkWriteContract(`PATCH /api/messages/${message(1).id}/extra`, { status: 200, body: {} })).toBeNull();
  });
});
