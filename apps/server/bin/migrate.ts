import { runMigrateCli } from './lib/migrate-cli.js';

/**
 * 로컬 전용 운영 명령: 미적용 마이그레이션 적용(런북: docs/runbooks/BOOTSTRAP_OWNER.md §0).
 * 접속은 DATABASE_URL(루프백 호스트만)만 쓰며 사람이 셸에서 직접 로드한다. `--dry-run`은 적용 예정 목록만 조회한다.
 */
process.exitCode = await runMigrateCli(process.argv.slice(2), process.env, process);
