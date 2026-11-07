/** 바인드 주소 검사(정본: TRD §6, NC-05). 루프백 127.0.0.1 외(0.0.0.0·LAN·::)는 기동 거부. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

export class BindGuardError extends Error {
  override readonly name = 'BindGuardError';
}

export function assertLoopbackBind(host: string | undefined): string {
  const value = host === undefined || host === '' ? DEFAULT_BIND_HOST : host;
  if (value !== DEFAULT_BIND_HOST) throw new BindGuardError(`루프백(127.0.0.1)이 아닌 바인드 주소는 거부합니다: ${value}`);
  return value;
}

export function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1–65535 정수여야 합니다');
  return port;
}
