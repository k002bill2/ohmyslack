// CP1 전용: CP2에서 각 스크립트 자체 테스트로 교체한다.
import { describe, expect, it } from 'vitest';
import { captureCtx } from './helpers.ts';
import { run as cleanroom } from '../check-cleanroom.ts';
import { run as noPersist } from '../check-no-persist-cache.ts';
import { run as tokens } from '../check-design-tokens.ts';
import { run as fr } from '../check-fr-coverage.ts';
import { run as leak } from '../check-log-leak.ts';
import { run as db } from '../assert-test-db.ts';

describe('CP1 placeholders', () => {
  it('report 미구현', async () => {
    const ctx = captureCtx('.', {});
    for (const fn of [cleanroom, noPersist, tokens, fr, leak]) expect(await fn([], ctx)).toBe(0);
    expect(await db([], ctx)).toBe(1);
  });
});
