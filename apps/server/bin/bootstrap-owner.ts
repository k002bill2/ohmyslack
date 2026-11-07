import pg from 'pg';
import { runBootstrapOwner } from './lib/bootstrap.js';

/**
 * 로컬 전용 운영 명령(런북: docs/runbooks/BOOTSTRAP_OWNER.md). 원격 라우트에서 import하지 않는다.
 * 접속은 DATABASE_URL만 쓰며 사람이 셸에서 직접 로드한다. 비밀번호는 TTY(echo 끔) 또는 stdin 첫 줄로만 받는다.
 */
async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    process.stderr.write('bootstrap-owner 실패(config): DATABASE_URL이 설정되지 않았습니다. 변경 없음.\n');
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return await runBootstrapOwner(process.argv.slice(2), process, pool);
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
