import { useEffect, useState } from 'react';
import { createMemoryDataSource, type DataSource } from './data';
import { AppShell } from './features/layout';
import type { SessionBus } from './features/sync';

const DEV_SEED = {
  spaces: [
    { id: 'c1', kind: 'channel', name: 'general', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
    { id: 'c2', kind: 'channel', name: 'dev', unreadCount: 3, mentionCount: 2, unreadThreadCount: 1 },
    { id: 'd1', kind: 'dm', name: 'B', unreadCount: 0, mentionCount: 0, unreadThreadCount: 0 },
  ],
  messages: [],
  connection: 'connected',
} as const;

const SIGNED_OUT = { spaces: [], messages: [], connection: 'connected' } as const;

/**
 * 앱 루트(개발용): 메모리 DataSource로 AppShell을 렌더한다. 운영 HTTP·WS 연결은 다음 웹 레인.
 * 세션 종료(로그아웃·401·계정 전환) 시 DataSource를 빈 것으로 바꾸고 AppShell을 다시 마운트해
 * 화면 본문·초안 등 메모리 상태를 모두 버린다(FR-CLIENT-04).
 */
export function App({ dataSource, session }: { readonly dataSource?: DataSource; readonly session?: SessionBus }) {
  const [source, setSource] = useState<DataSource>(() => dataSource ?? createMemoryDataSource(DEV_SEED));
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      session?.onEnd(() => {
        setSource(createMemoryDataSource(SIGNED_OUT));
        setGeneration((g) => g + 1);
      }),
    [session],
  );
  return <AppShell key={generation} dataSource={source} />;
}
