import pg from 'pg';
import { createBotEvents, createBotService, runBotAdmin } from '../src/modules/bots/index.js';
import { checkLoopbackUrl } from './lib/migrate-cli.js';

/**
 * 봇 계정·토큰 관리 로컬 전용 명령(정본: TRD §5-2 1·2항, ADR-001). 원격 라우트에서 import하지 않는다.
 * 접속은 DATABASE_URL(루프백 호스트만)만 쓰며 사람이 셸에서 직접 로드한다. 토큰 원문은 발급·회전 시 stdout에 1회만 쓴다.
 * 실행 중인 서버의 열린 봇 WS는 서버 쪽 sweep이 닫는다(이 프로세스의 연결 닫기 훅은 구독자가 없다).
 */
async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write('bot-admin 실패(config): DATABASE_URL이 설정되지 않았습니다. 변경 없음.\n');
    return 2;
  }
  const check = checkLoopbackUrl(url);
  if (!check.ok) {
    process.stderr.write(`bot-admin 실패(${check.code}): 루프백 호스트(127.0.0.1·localhost·::1)의 postgres URL만 허용합니다. 변경 없음.\n`);
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on('error', () => undefined);
  try {
    return await runBotAdmin(process.argv.slice(2), process, createBotService({ pool, events: createBotEvents() }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main();
