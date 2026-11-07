import type { Readable, Writable } from 'node:stream';

/** TTY면 raw 모드(echo 끔)로, 파이프면 stdin 첫 줄로 비밀 값을 읽는다. argv·환경변수로는 받지 않는다. */
export interface SecretInput extends Readable {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export class SecretInputError extends Error {
  override readonly name = 'SecretInputError';
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

/** TTY 한 줄 읽기: 입력 글자를 화면에 되돌려 쓰지 않는다. */
function readTtyLine(input: SecretInput, output: Writable, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(prompt);
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    const finish = (error?: Error): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === CTRL_C || char === CTRL_D) return finish(new SecretInputError('입력이 취소되었습니다'));
        if (char === '\r' || char === '\n') return finish();
        if (BACKSPACE.has(char)) value = Array.from(value).slice(0, -1).join('');
        else value += char;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

/** 파이프 입력: 첫 줄만 쓰고 줄 끝 \n 또는 \r\n 하나만 뗀다(trim·정규화하지 않는다). */
async function readPipedLine(input: Readable): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    if (text.includes('\n')) break;
  }
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 새 비밀번호를 읽는다. TTY에서는 두 번 입력받아 일치를 확인한다. */
export async function readNewSecret(input: SecretInput, prompts: Writable): Promise<string> {
  if (input.isTTY !== true) return readPipedLine(input);
  const first = await readTtyLine(input, prompts, '새 비밀번호: ');
  const second = await readTtyLine(input, prompts, '비밀번호 확인: ');
  if (first !== second) throw new SecretInputError('두 입력이 일치하지 않습니다');
  return first;
}
