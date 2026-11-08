/**
 * live-e2e.sh 보조: TEST DB 실행 스키마 URL·생성·삭제. 입력은 env `TEST_DATABASE_URL`·`LIVE_SCHEMA`만(argv에 URL 금지).
 * 검사는 tools/assert-test-db.ts(루프백·`_test` DB)와 apps/server/test/support/test-db.ts 스키마 이름 규칙을 그대로 쓴다.
 * 사용: tsx live-e2e-db.ts url|create|drop — `url`만 stdout에 스키마 고정 URL을 쓴다(호출자가 변수로 받는다).
 */
import { createRequire } from 'node:module';
import { checkTestDbUrl } from '../../../tools/assert-test-db.ts';

const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const pg = require('pg') as typeof import('pg');
const SCHEMA_PATTERN = /^t_[a-z0-9_]+$/;

function fail(reason: string): never {
  process.stderr.write(`live-e2e-db 실패: ${reason}\n`);
  process.exit(2);
}

const raw = process.env.TEST_DATABASE_URL;
const check = checkTestDbUrl(raw);
if (!check.ok || raw === undefined) fail(`assert-test-db 거부: ${check.reason}`);
const schema = process.env.LIVE_SCHEMA ?? '';
if (!SCHEMA_PATTERN.test(schema)) fail('LIVE_SCHEMA 형식 위반(^t_[a-z0-9_]+$)');
const base = new URL(raw);
if ([...base.searchParams.keys()].length > 0) fail('TEST_DATABASE_URL 의 쿼리 파라미터는 허용하지 않습니다');

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: raw });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const command = process.argv[2];
if (command === 'url') {
  const url = new URL(raw);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.stdout.write(`${url.toString()}\n`);
} else if (command === 'create') {
  await admin(`CREATE SCHEMA "${schema}"`);
} else if (command === 'drop') {
  await admin(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
} else {
  fail('사용법: live-e2e-db.ts url|create|drop');
}
