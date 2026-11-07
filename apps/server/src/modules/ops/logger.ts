/**
 * ops 로거(정본: DEV_DESIGN §2-2 B6). 허용 필드 목록 밖의 키는 버리고, 값은 원시형만 남긴다.
 * 쿠키·Authorization·본문·이메일·IP·URL query는 허용 필드가 아니므로 직렬화 단계에서 사라진다.
 */
export const LOG_ALLOWED_FIELDS = Object.freeze([
  'event',
  'method',
  'route',
  'status_code',
  'duration_ms',
  'request_id',
  'error_code',
] as const);

export type LogField = (typeof LOG_ALLOWED_FIELDS)[number];
export type LogRecord = Partial<Record<LogField, string | number>>;
export type LogSink = (line: string) => void;

export interface OpsLogger {
  log(fields: Readonly<Record<string, unknown>>): void;
}

const MAX_STRING = 200;
const ALLOWED: ReadonlySet<string> = new Set(LOG_ALLOWED_FIELDS);

/** 허용 필드만 골라 새 객체로 돌려준다(입력 불변). */
export function redact(fields: Readonly<Record<string, unknown>>): LogRecord {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING);
  }
  return out;
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createOpsLogger(sink: LogSink = stdoutSink): OpsLogger {
  return {
    log(fields) {
      sink(JSON.stringify(redact(fields)));
    },
  };
}
