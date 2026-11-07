import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readNewSecret } from '../../bin/lib/secret-input.js';

const silent = new Writable({ write: (_chunk, _enc, cb) => cb() });

/** 파이프 입력(비 TTY): 다중 바이트 문자가 청크 경계에서 갈라져도 원문 그대로 읽는다(Codex P2). */
describe('readNewSecret pipe', () => {
  it('UTF-8 문자가 청크 사이에서 나뉘어도 깨지지 않는다', async () => {
    const secret = '비밀번호🔐pass-phrase';
    const bytes = Buffer.from(`${secret}\n`, 'utf8');
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
    await expect(readNewSecret(Readable.from(chunks), silent)).resolves.toBe(secret);
  });

  it('첫 줄만 쓰고 줄 끝 \\r\\n 하나만 뗀다(공백은 보존)', async () => {
    await expect(readNewSecret(Readable.from(['  a b  \r\nsecond\n']), silent)).resolves.toBe('  a b  ');
  });
});
