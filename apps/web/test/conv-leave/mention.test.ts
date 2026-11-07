/** CMP-12 순수 함수: 트리거·필터(자기 제외·상한)·삽입·전송 ID. */
import { describe, expect, it } from 'vitest';
import {
  MENTION_CANDIDATE_LIMIT,
  filterCandidates,
  insertMention,
  mentionIdsIn,
  mentionQuery,
} from '../../src/features/conversation/mention.js';
import { MENTION_IDS_MAX } from '../../../../packages/shared/src/index.js';

describe('mentionQuery', () => {
  it('줄 처음·공백 뒤 @만 트리거, 커서까지 공백 없음', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @ki', 6)).toEqual({ start: 3, query: 'ki' });
    expect(mentionQuery('mail@x', 6)).toBeNull();
    expect(mentionQuery('@ki m', 5)).toBeNull();
    expect(mentionQuery('no trigger', 10)).toBeNull();
  });
});

describe('filterCandidates', () => {
  const list = [
    { id: 'me', displayName: 'Alice' },
    { id: 'b', displayName: 'Bob' },
    { id: 'c', displayName: 'bobby' },
  ];
  it('자기 자신 제외 + 대소문자 무시 부분 일치', () => {
    expect(filterCandidates(list, 'BO', 'me').map((c) => c.id)).toEqual(['b', 'c']);
    expect(filterCandidates(list, 'ali', 'me')).toEqual([]);
  });
  it('상한 = 서버 mention_user_ids 상한', () => {
    expect(MENTION_CANDIDATE_LIMIT).toBe(MENTION_IDS_MAX);
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `u${i}`, displayName: `u${i}` }));
    expect(filterCandidates(many, '', undefined)).toHaveLength(MENTION_CANDIDATE_LIMIT);
  });
});

describe('insertMention · mentionIdsIn', () => {
  it('@query → @이름 + 공백, 커서는 뒤', () => {
    expect(insertMention('hi @bo there', { start: 3, query: 'bo' }, 'Bob')).toEqual({ text: 'hi @Bob  there', caret: 8 });
  });
  it('본문에 남은 멘션만, 중복 제거', () => {
    const sel = [
      { id: 'b', displayName: 'Bob' },
      { id: 'b', displayName: 'Bob' },
      { id: 'c', displayName: 'Carl' },
    ];
    expect(mentionIdsIn('hi @Bob', sel)).toEqual(['b']);
  });
});
