import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CliRefusal, inTransaction } from '../../../bin/lib/cli.js';
import { dmPairKey } from '../conversations/service.js';
import type { BotEvents } from './events.js';
import * as repo from './repo.js';
import { generateBotToken, hashBotToken, hasBotTokenShape } from './token.js';

/**
 * 봇 계정·토큰 서비스(정본: TRD §5-2 1·2·5항, ADR-001). 로컬 CLI(bin/bot-admin.ts)만 쓰며 원격 라우트에서 부르지 않는다.
 * 거부는 고정 문구 CliRefusal로 던진다(입력값·토큰을 메시지에 담지 않음). 연결 닫기 훅은 COMMIT 뒤에만 발행한다.
 */
export const MAX_LIVE_TOKENS = 2;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 64;
const NAME_MAX = 80;

export interface CreatedBot {
  readonly botUserId: string;
  readonly slug: string;
  readonly dmConversationId: string;
}

export interface IssuedBotToken {
  readonly tokenId: string;
  /** 원문. 발급 응답에서 1회만 존재한다. */
  readonly token: string;
}

export interface RotatedBotToken extends IssuedBotToken {
  /** 새 토큰 발급 뒤에도 살아 있는 옛 토큰 id(어댑터 교체 후 폐기할 대상). */
  readonly previousTokenIds: readonly string[];
}

export interface BotService {
  createBot(input: { readonly displayName: string; readonly slug?: string }): Promise<CreatedBot>;
  issueToken(botUserId: string, label: string): Promise<IssuedBotToken>;
  rotateToken(botUserId: string): Promise<RotatedBotToken>;
  /** 이미 폐기된 토큰은 그대로 성공(멱등). 없는 토큰은 거부. 반환값은 이번 호출로 폐기했는지. */
  revokeToken(tokenId: string): Promise<{ readonly revoked: boolean }>;
  disableBot(botUserId: string): Promise<{ readonly revokedTokenIds: readonly string[] }>;
  listBots(): Promise<readonly repo.BotRow[]>;
  findBotIdBySlug(slug: string): Promise<string | undefined>;
  verifyToken(raw: string): Promise<{ readonly botUserId: string; readonly tokenId: string } | undefined>;
  /** 주어진 토큰 ID 중 지금 유효한 것만(단일 쿼리, last_used_at 불변). 봇 WS sweep·전달 재확인용. */
  liveTokenIds(tokenIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** 봇 리스너 `GET me`: 워크스페이스 활성 owner, 봇 표시 이름, 활성 참여 대화 id·종류(TRD §5-2 6항, BOT_CHANNEL_SPEC §4-4). */
  me(botUserId: string): Promise<repo.BotMeRow>;
}

export interface BotServiceDeps {
  readonly pool: pg.Pool;
  readonly events: BotEvents;
  readonly clock?: () => number;
}

/** 표시 이름에서 slug 유도: 소문자 ASCII 영숫자 외 구간은 '-'로, 양끝 '-' 제거, 32자 절단. */
export function deriveSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

function validSlug(raw: string | undefined, displayName: string): string {
  const slug = raw ?? deriveSlug(displayName);
  if (!SLUG_PATTERN.test(slug)) {
    throw new CliRefusal('invalid_slug', 'slug는 소문자 영숫자로 시작하고 영숫자·-만 쓰는 1–32자여야 합니다(--slug로 지정)', true);
  }
  return slug;
}

function validName(raw: string): string {
  const name = raw.trim().normalize('NFC');
  if (name === '' || [...name].length > NAME_MAX) throw new CliRefusal('invalid_name', `표시 이름은 1–${NAME_MAX}자여야 합니다`, true);
  return name;
}

function validLabel(raw: string): string {
  const label = raw.trim();
  if (label === '' || [...label].length > LABEL_MAX) throw new CliRefusal('invalid_label', `라벨은 1–${LABEL_MAX}자여야 합니다`, true);
  return label;
}

async function soleWorkspace(client: pg.PoolClient): Promise<{ readonly workspaceId: string; readonly ownerId: string }> {
  const ids = await repo.workspaceIds(client);
  if (ids.length === 0) throw new CliRefusal('no_workspace', '워크스페이스가 없습니다');
  if (ids.length > 1) throw new CliRefusal('multiple_workspaces', '워크스페이스가 2개 이상입니다');
  const workspaceId = ids[0] as string;
  const ownerId = await repo.activeOwnerId(client, workspaceId);
  if (ownerId === undefined) throw new CliRefusal('no_owner', '활성 owner가 없습니다');
  return { workspaceId, ownerId };
}

/** 잠금 → 상태 확인 → 미폐기 개수 확인 → 삽입. 같은 봇의 동시 발급은 users 행 잠금에서 직렬화된다. */
async function issueLocked(client: pg.PoolClient, botUserId: string, label: string, at: Date): Promise<RotatedBotToken> {
  const status = await repo.lockBot(client, botUserId);
  if (status === undefined) throw new CliRefusal('no_such_bot', '해당 봇이 없습니다');
  if (status !== 'active') throw new CliRefusal('bot_disabled', '비활성화된 봇입니다');
  const live = await repo.liveTokenIds(client, botUserId);
  if (live.length >= MAX_LIVE_TOKENS) {
    throw new CliRefusal('token_limit', `미폐기 토큰이 이미 ${MAX_LIVE_TOKENS}개입니다. 옛 토큰을 먼저 폐기하세요`);
  }
  const token = generateBotToken();
  const tokenId = randomUUID();
  await repo.insertToken(client, { id: tokenId, botUserId, tokenHash: hashBotToken(token), label, at });
  return { tokenId, token, previousTokenIds: Object.freeze([...live]) };
}

function requireUuid(id: string, code: string, message: string): void {
  if (!UUID_PATTERN.test(id)) throw new CliRefusal(code, message, true);
}

/** 한 트랜잭션: 단일 워크스페이스·활성 owner 확인 → 봇 users·workspace_members(member) → owner–봇 DM. */
function createBotTx(pool: pg.Pool, input: { readonly displayName: string; readonly slug?: string }, at: Date): Promise<CreatedBot> {
  const displayName = validName(input.displayName);
  const slug = validSlug(input.slug, displayName);
  const emailNorm = `${slug}${repo.BOT_EMAIL_DOMAIN}`;
  return inTransaction(pool, async (client) => {
    const { workspaceId, ownerId } = await soleWorkspace(client);
    if (await repo.emailTaken(client, emailNorm)) throw new CliRefusal('slug_taken', '같은 slug의 봇이 이미 있습니다');
    const botUserId = randomUUID();
    const dmConversationId = randomUUID();
    await repo.insertBotUser(client, { id: botUserId, workspaceId, emailNorm, displayName });
    const pairKey = dmPairKey(ownerId, botUserId);
    await repo.insertOwnerDm(client, { id: dmConversationId, workspaceId, pairKey, memberIds: [ownerId, botUserId], at });
    return { botUserId, slug, dmConversationId };
  });
}

export function createBotService(deps: BotServiceDeps): BotService {
  const { pool, events } = deps;
  const clock = deps.clock ?? Date.now;
  const now = (): Date => new Date(clock());

  return {
    createBot: (input) => createBotTx(pool, input, now()),
    async issueToken(botUserId, label) {
      requireUuid(botUserId, 'no_such_bot', '해당 봇이 없습니다');
      const clean = validLabel(label);
      const issued = await inTransaction(pool, (client) => issueLocked(client, botUserId, clean, now()));
      return { tokenId: issued.tokenId, token: issued.token };
    },
    async rotateToken(botUserId) {
      requireUuid(botUserId, 'no_such_bot', '해당 봇이 없습니다');
      return inTransaction(pool, (client) => issueLocked(client, botUserId, 'rotate', now()));
    },
    async revokeToken(tokenId) {
      requireUuid(tokenId, 'no_such_token', '해당 토큰이 없습니다');
      const botUserId = await repo.revokeTokenRow(pool, tokenId, now());
      if (botUserId === undefined) {
        if (!(await repo.tokenExists(pool, tokenId))) throw new CliRefusal('no_such_token', '해당 토큰이 없습니다');
        return { revoked: false };
      }
      events.connectionsClose({ botUserId, tokenIds: [tokenId] });
      return { revoked: true };
    },
    async disableBot(botUserId) {
      requireUuid(botUserId, 'no_such_bot', '해당 봇이 없습니다');
      const revokedTokenIds = await inTransaction(pool, async (client) => {
        if ((await repo.lockBot(client, botUserId)) === undefined) throw new CliRefusal('no_such_bot', '해당 봇이 없습니다');
        return repo.disableBotRows(client, botUserId, now());
      });
      events.connectionsClose({ botUserId, tokenIds: revokedTokenIds });
      return { revokedTokenIds: Object.freeze([...revokedTokenIds]) };
    },
    listBots: () => repo.listBotRows(pool),
    findBotIdBySlug: (slug) => (SLUG_PATTERN.test(slug) ? repo.botIdBySlug(pool, slug) : Promise.resolve(undefined)),
    async verifyToken(raw) {
      if (!hasBotTokenShape(raw)) return undefined;
      return repo.touchLiveToken(pool, hashBotToken(raw), now());
    },
    liveTokenIds: (tokenIds) => repo.liveTokenIdsAmong(pool, tokenIds),
    me: (botUserId) => repo.botMe(pool, botUserId),
  };
}
