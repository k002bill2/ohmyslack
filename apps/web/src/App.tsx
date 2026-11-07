import { useState } from 'react';
import { createMemoryDataSource, type DataSource } from './data';
import { AppShell } from './features/layout';

const DEV_SEED = {
  spaces: [
    { id: 'c1', kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
    { id: 'c2', kind: 'channel', name: 'dev', unreadCount: 3, mentionCount: 2, unreadThreadCount: 1 },
    { id: 'd1', kind: 'dm', name: 'B', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
  ],
  messages: [],
  connection: 'connected',
} as const;

/** 앱 루트(개발용): 메모리 DataSource로 AppShell을 렌더한다. 운영 HTTP·WS 연결은 다음 웹 레인. */
export function App({ dataSource }: { readonly dataSource?: DataSource }) {
  const [source] = useState(() => dataSource ?? createMemoryDataSource(DEV_SEED));
  return <AppShell dataSource={source} />;
}
