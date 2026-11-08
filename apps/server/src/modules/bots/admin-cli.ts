import { CliRefusal, parseOptions, runCommand, type CliIo } from '../../../bin/lib/cli.js';
import type { BotService } from './service.js';

/**
 * 봇 관리 로컬 명령의 인자 해석·분기(정본: TRD §5-2 1·2항). 원격 경로 없음.
 * 토큰 원문은 issue·rotate 성공 시 stdout에 정확히 1회만 쓴다. stderr·로거에는 쓰지 않는다.
 */
const USAGE =
  '사용법: bot-admin create --name <표시 이름> [--slug <slug>] | token issue --bot <slug> [--label <라벨>] | ' +
  'token rotate --bot <slug> | token revoke --id <토큰 id> | disable --bot <slug> | list';
const DEFAULT_LABEL = 'cli';

function usage(): CliRefusal {
  return new CliRefusal('usage', USAGE);
}

function options<K extends string>(argv: readonly string[], names: readonly K[]): Partial<Record<K, string>> {
  const parsed = parseOptions(argv, names);
  if (parsed === undefined) throw usage();
  return parsed;
}

async function botId(service: BotService, slug: string | undefined): Promise<string> {
  if (slug === undefined) throw usage();
  const id = await service.findBotIdBySlug(slug);
  if (id === undefined) throw new CliRefusal('no_such_bot', '해당 봇이 없습니다');
  return id;
}

async function create(argv: readonly string[], service: BotService): Promise<string> {
  const { name, slug } = options(argv, ['name', 'slug']);
  if (name === undefined) throw usage();
  const bot = await service.createBot({ displayName: name, ...(slug === undefined ? {} : { slug }) });
  return `봇을 만들었습니다(slug ${bot.slug}, owner DM 생성)`;
}

async function issue(argv: readonly string[], service: BotService): Promise<string> {
  const { bot, label } = options(argv, ['bot', 'label']);
  const issued = await service.issueToken(await botId(service, bot), label ?? DEFAULT_LABEL);
  return `토큰을 발급했습니다(id ${issued.tokenId}). 아래 원문은 다시 출력하지 않습니다\n${issued.token}`;
}

async function rotate(argv: readonly string[], service: BotService): Promise<string> {
  const { bot } = options(argv, ['bot']);
  const rotated = await service.rotateToken(await botId(service, bot));
  const previous = rotated.previousTokenIds.length === 0 ? '없음' : rotated.previousTokenIds.join(', ');
  return (
    `새 토큰을 발급했습니다(id ${rotated.tokenId}). 어댑터 교체 뒤 옛 토큰(${previous})을 token revoke로 폐기하세요. ` +
    `아래 원문은 다시 출력하지 않습니다\n${rotated.token}`
  );
}

async function revoke(argv: readonly string[], service: BotService): Promise<string> {
  const { id } = options(argv, ['id']);
  if (id === undefined) throw usage();
  const result = await service.revokeToken(id);
  return result.revoked ? '토큰을 폐기했습니다' : '이미 폐기된 토큰입니다';
}

async function disable(argv: readonly string[], service: BotService): Promise<string> {
  const { bot } = options(argv, ['bot']);
  const result = await service.disableBot(await botId(service, bot));
  return `봇을 비활성화하고 토큰 ${result.revokedTokenIds.length}개를 폐기했습니다`;
}

async function list(argv: readonly string[], service: BotService): Promise<string> {
  options(argv, []);
  const bots = await service.listBots();
  const lines = bots.map((b) => `${b.slug}\t${b.status}\t미폐기 토큰 ${b.liveTokenCount}개\t${b.displayName}\t${b.id}`);
  return [`봇 ${bots.length}개`, ...lines].join('\n');
}

type Handler = (argv: readonly string[], service: BotService) => Promise<string>;

const COMMANDS: Readonly<Record<string, Handler>> = Object.freeze({
  create,
  'token issue': issue,
  'token rotate': rotate,
  'token revoke': revoke,
  disable,
  list,
});

/** CLI 진입: 명령 단어(1–2개)를 떼고 나머지를 엄격 옵션으로 해석한다. 반환값은 종료 코드(0·1 거부·2 사용법). */
export function runBotAdmin(argv: readonly string[], io: CliIo, service: BotService): Promise<number> {
  const words = argv[0] === 'token' ? 2 : 1;
  const command = argv.slice(0, words).join(' ');
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  // 알 수 없는 명령 단어는 출력에 되풀이하지 않는다(붙여넣은 토큰일 수 있음).
  const label = handler === undefined ? 'bot-admin' : `bot-admin ${command}`;
  return runCommand(io, label, async () => {
    if (handler === undefined) throw usage();
    return handler(argv.slice(words), service);
  });
}
