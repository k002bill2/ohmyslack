import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { hashPassword, normalizeEmail } from '../../src/modules/auth/password.js';
import { CliRefusal, inTransaction, parseOptions, readPolicyPassword, runCommand, type CliIo } from './cli.js';

/** 최초 owner 생성(정본: TRD §5, DEV_DESIGN W-05b BOOT-01). owner가 1명이라도 있으면 어떤 행도 바꾸지 않는다. */
export interface BootstrapOwnerInput {
  readonly email: string;
  readonly displayName: string;
  /** 워크스페이스가 없을 때만 쓰인다. */
  readonly workspaceName?: string;
  readonly password: string;
}

export interface BootstrapOwnerResult {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceCreated: boolean;
}

const USAGE = '사용법: bootstrap-owner --email <이메일> --name <표시 이름> [--workspace <워크스페이스 이름>] (비밀번호는 TTY 또는 stdin)';

/** 셸 밖(메모·메신저)에서 복사한 따옴표가 값에 섞인 흔적. 양끝만 본다(중간 따옴표는 이름일 수 있다). */
const EDGE_QUOTES = new Set(['"', "'", '\u201C', '\u201D', '\u2018', '\u2019']);

/** 양끝 공백 제거 후 첫·끝 글자가 따옴표면 거부한다(조용히 고치지 않음). 값은 출력하지 않고 길이만 알린다. */
function refuseEdgeQuotes(option: 'name' | 'workspace', value: string | undefined): void {
  if (value === undefined) return;
  const chars = [...value.trim()];
  const first = chars[0];
  const last = chars[chars.length - 1];
  if (first === undefined || last === undefined) return;
  if (!EDGE_QUOTES.has(first) && !EDGE_QUOTES.has(last)) return;
  throw new CliRefusal(
    'quoted_value',
    `--${option} 값(길이 ${chars.length}자)의 앞이나 끝에 따옴표 문자(" ' “ ” ‘ ’)가 값으로 들어 있습니다. ` +
      '셸에서 직접 입력한 " 로 값 전체를 감싸 다시 실행하세요(예: --name "홍길동"). 따옴표를 복사해 붙여넣지 마세요',
    true,
  );
}

async function resolveWorkspace(client: pg.PoolClient, name: string | undefined): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY created_at, id');
  if (existing.rows.length > 1) throw new CliRefusal('multiple_workspaces', '워크스페이스가 2개 이상입니다');
  const row = existing.rows[0];
  if (row !== undefined) return { id: row.id, created: false };
  const trimmed = name?.trim() ?? '';
  if (trimmed === '') throw new CliRefusal('workspace_name_required', '워크스페이스가 없어 --workspace 이름이 필요합니다');
  const id = randomUUID();
  await client.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, now())', [id, trimmed]);
  return { id, created: true };
}

/** 한 트랜잭션: owner 존재 확인(잠금) → 워크스페이스 확보 → users·workspace_members(owner) 생성. */
export async function bootstrapOwner(pool: pg.Pool, input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
  const emailNorm = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!emailNorm.includes('@') || displayName === '') throw new CliRefusal('usage', USAGE);
  const passwordHash = await hashPassword(input.password);
  return inTransaction(pool, async (client) => {
    await client.query('LOCK TABLE workspace_members IN SHARE ROW EXCLUSIVE MODE');
    const owners = await client.query("SELECT 1 FROM workspace_members WHERE role = 'owner' LIMIT 1");
    if (owners.rowCount !== 0) throw new CliRefusal('owner_exists', 'owner가 이미 있습니다. 재실행은 기존 계정을 바꾸지 않습니다');
    const workspace = await resolveWorkspace(client, input.workspaceName);
    const taken = await client.query('SELECT 1 FROM users WHERE email_norm = $1', [emailNorm]);
    if (taken.rowCount !== 0) throw new CliRefusal('email_taken', '같은 이메일 계정이 이미 있습니다');
    const userId = randomUUID();
    await client.query(
      "INSERT INTO users (id, email_norm, display_name, password_hash, status) VALUES ($1, $2, $3, $4, 'active')",
      [userId, emailNorm, displayName, passwordHash],
    );
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
      workspace.id,
      userId,
    ]);
    return { userId, workspaceId: workspace.id, workspaceCreated: workspace.created };
  });
}

/** CLI 진입: 인자 검사 → 비노출 비밀번호 입력 → bootstrapOwner. 반환값은 종료 코드. */
export function runBootstrapOwner(argv: readonly string[], io: CliIo, pool: pg.Pool): Promise<number> {
  return runCommand(io, 'bootstrap-owner', async () => {
    const options = parseOptions(argv, ['email', 'name', 'workspace']);
    if (options?.email === undefined || options.name === undefined) throw new CliRefusal('usage', USAGE);
    refuseEdgeQuotes('name', options.name);
    refuseEdgeQuotes('workspace', options.workspace);
    const password = await readPolicyPassword(io);
    const result = await bootstrapOwner(pool, {
      email: options.email,
      displayName: options.name,
      password,
      ...(options.workspace === undefined ? {} : { workspaceName: options.workspace }),
    });
    return result.workspaceCreated ? 'owner와 워크스페이스를 만들었습니다' : 'owner를 만들었습니다(기존 워크스페이스)';
  });
}
