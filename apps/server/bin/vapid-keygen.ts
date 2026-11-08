import { writeFile } from 'node:fs/promises';
import { generateVAPIDKeys } from 'web-push';

/**
 * 로컬 전용 운영 명령(정본: TRD §6-2): VAPID P-256 키쌍을 만들어 비밀 파일(모드 600)로 쓴다.
 * 사용법: `tsx bin/vapid-keygen.ts <경로>` 또는 PUSH_VAPID_KEY_FILE. 기존 파일은 덮어쓰지 않는다(exclusive create).
 * 출력은 공개키 한 줄뿐이다(개인키·경로 미출력). 파일은 저장소 밖에 둔다.
 */
async function main(): Promise<number> {
  const path = process.argv[2] ?? process.env.PUSH_VAPID_KEY_FILE ?? '';
  if (path === '') {
    process.stderr.write('vapid-keygen 실패(config): 경로 인자 또는 PUSH_VAPID_KEY_FILE이 필요합니다. 변경 없음.\n');
    return 2;
  }
  const keys = generateVAPIDKeys();
  const content = `${JSON.stringify({ public_key: keys.publicKey, private_key: keys.privateKey })}\n`;
  try {
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const exists = typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
    process.stderr.write(exists ? 'vapid-keygen 실패: 파일이 이미 있습니다(덮어쓰지 않음). 변경 없음.\n' : 'vapid-keygen 실패: 파일을 쓸 수 없습니다. 변경 없음.\n');
    return 1;
  }
  process.stdout.write(`${keys.publicKey}\n`);
  return 0;
}

process.exitCode = await main();
