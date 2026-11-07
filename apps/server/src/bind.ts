import type { AddressInfo } from 'node:net';

/** 바인드 주소 검사(정본: TRD §6, NC-05, FR-OPS-01). 루프백 127.0.0.1 외(0.0.0.0·LAN·::·tailnet IP)는 기동 거부. */
export const LOOPBACK_HOST = '127.0.0.1';
/** HOST 설정이 없을 때 쓰는 기본 바인드 주소. */
export const DEFAULT_BIND_HOST = LOOPBACK_HOST;

export class BindGuardError extends Error {
  override readonly name = 'BindGuardError';
}

export function assertLoopbackBind(host: string | undefined): string {
  const value = host === undefined || host === '' ? DEFAULT_BIND_HOST : host;
  if (value !== LOOPBACK_HOST) throw new BindGuardError(`루프백(127.0.0.1)이 아닌 바인드 주소는 거부합니다: ${value}`);
  return value;
}

/** 환경 변수(HOST)에서 리스너 주소를 정한다. 누락·빈 값은 기본값, 루프백 외는 BindGuardError. */
export function resolveListenHost(env: Readonly<Record<string, string | undefined>>): string {
  return assertLoopbackBind(env.HOST);
}

export function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1–65535 정수여야 합니다');
  return port;
}

/** listen만 가진 최소 서버 경계(Fastify 인스턴스가 만족한다). */
export interface Listenable {
  listen(options: { host: string; port: number }): Promise<string>;
  readonly server: { address(): AddressInfo | string | null };
}

/**
 * 바인드 검사를 **리스너를 열기 전에** 수행한 뒤 listen한다(NC-05). 검사 실패 시 listen을 호출하지 않는다.
 * port 0은 테스트용 임시 포트(운영 PORT는 parsePort가 1–65535로 제한).
 */
export async function listenLoopback(app: Listenable, env: Readonly<Record<string, string | undefined>>, port: number): Promise<AddressInfo> {
  const host = resolveListenHost(env);
  await app.listen({ host, port });
  const address = app.server.address();
  if (address === null || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
    throw new BindGuardError('리스너가 루프백 주소에 바인드되지 않았습니다');
  }
  return address;
}
