import { createMemoryDataSource, type MemoryDataSource, type Snapshot } from '../../src/data';

export const T0 = '2026-11-07T06:12:00.000Z';

export function seed(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    spaces: [
      { id: 'c1', kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
      { id: 'c2', kind: 'channel', name: 'dev', unreadCount: 2, mentionCount: 3, unreadThreadCount: 1 },
      { id: 'd1', kind: 'dm', name: '홍길동', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
    ],
    messages: [
      { id: 'm1', conversationId: 'c1', author: '홍길동', createdAt: T0, body: '안녕하세요', replyCount: 1 },
      { id: 'm2', conversationId: 'c1', author: '김철수', createdAt: T0, body: '반갑습니다', replyCount: 0 },
      { id: 'r1', conversationId: 'c1', rootId: 'm1', author: '김철수', createdAt: T0, body: '답장', replyCount: 0 },
      { id: 'm3', conversationId: 'c2', author: '홍길동', createdAt: T0, body: '개발 채널', replyCount: 0 },
    ],
    connection: 'connected',
    ...overrides,
  };
}

export function memory(overrides: Partial<Snapshot> = {}): MemoryDataSource {
  return createMemoryDataSource(seed(overrides));
}
