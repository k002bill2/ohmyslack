import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runBootstrapOwner } from '../../bin/lib/bootstrap.js';
import { pipedIo } from './bootstrap-harness.js';

/** owner CLI: --name·--workspace 값 양끝 따옴표(셸 밖에서 붙여넣은 흔적)는 DB 접속 전에 거부한다(DB 없음). */
const PASSWORD = 'correct-horse-battery-9';
const EMAIL = 'owner@example.test';
const QUOTES = ['"', "'", '“', '”', '‘', '’'] as const;
const PLACES = ['앞', '뒤', '양끝'] as const;
const FIELDS = ['name', 'workspace'] as const;

/** connect 호출 자체를 기록하는 가짜 풀. 접속하면 실패시킨다. */
function fakePool(): { pool: pg.Pool; connects: () => number } {
  let count = 0;
  const pool = {
    connect: () => {
      count += 1;
      return Promise.reject(new Error('db must not be touched'));
    },
    query: () => {
      count += 1;
      return Promise.reject(new Error('db must not be touched'));
    },
  } as unknown as pg.Pool;
  return { pool, connects: () => count };
}

function wrap(value: string, quote: string, place: (typeof PLACES)[number]): string {
  if (place === '앞') return `${quote}${value}`;
  if (place === '뒤') return `${value}${quote}`;
  return `${quote}${value}${quote}`;
}

function argvWith(field: (typeof FIELDS)[number], value: string): string[] {
  const name = field === 'name' ? value : 'Owner';
  const workspace = field === 'workspace' ? value : 'Home';
  return ['--email', EMAIL, '--name', name, '--workspace', workspace];
}

const CASES = FIELDS.flatMap((field) =>
  QUOTES.flatMap((quote) => PLACES.map((place) => ({ field, quote, place, code: quote.codePointAt(0)?.toString(16) }))),
);

describe('bootstrap-owner 이름 양끝 따옴표 거부', () => {
  it.each(CASES)('--$field 값 $place 위치 U+$code 따옴표가 있으면 종료 코드 2로 거부하고 DB에 접속하지 않는다', async ({ field, quote, place }) => {
    const value = wrap('  Jarvis Home ', quote, place);
    const padded = `  ${value}  `;
    const { pool, connects } = fakePool();
    const io = pipedIo(`${PASSWORD}\n`);
    expect(await runBootstrapOwner(argvWith(field, padded), io, pool)).toBe(2);
    expect(connects()).toBe(0);
    const err = io.err();
    expect(err).toContain('quoted_value');
    expect(err).toContain(`--${field}`);
    expect(err).toContain('따옴표');
    expect(err).toContain(`길이 ${[...padded.trim()].length}자`);
    expect(err).toContain('변경 없음');
    expect(err.includes('Jarvis')).toBe(false);
    expect(err.includes(EMAIL)).toBe(false);
    expect(err.includes(PASSWORD)).toBe(false);
    expect(io.out()).toBe('');
  });

  it.each(FIELDS)('--%s 값 중간의 따옴표는 허용한다(검사를 통과해 DB 단계로 간다)', async (field) => {
    const { pool, connects } = fakePool();
    const io = pipedIo(`${PASSWORD}\n`);
    const code = await runBootstrapOwner(argvWith(field, ` O'Brien “HQ” ‘x’ "y" Lab `), io, pool);
    expect(io.err()).not.toContain('quoted_value');
    expect(connects()).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it('따옴표 검사는 비밀번호 입력보다 먼저라 stdin을 읽지 않아도 거부한다', async () => {
    const { pool, connects } = fakePool();
    const io = pipedIo('');
    expect(await runBootstrapOwner(argvWith('name', '“Owner”'), io, pool)).toBe(2);
    expect(io.err()).toContain('quoted_value');
    expect(connects()).toBe(0);
  });

  it('--workspace를 생략하면 따옴표 검사 대상이 아니다', async () => {
    const { pool, connects } = fakePool();
    const io = pipedIo(`${PASSWORD}\n`);
    await runBootstrapOwner(['--email', EMAIL, '--name', 'Owner'], io, pool);
    expect(io.err()).not.toContain('quoted_value');
    expect(connects()).toBeGreaterThan(0);
  });
});
