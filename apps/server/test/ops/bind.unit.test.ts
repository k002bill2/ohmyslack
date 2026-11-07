import { describe, expect, it, vi } from 'vitest';
import { BindGuardError, listenLoopback, resolveListenHost, type Listenable } from '../../src/bind.js';

/** listenLoopback 경계 단위 검사(실제 소켓 없이). 실제 기동은 bind.int.test.ts가 판정한다. */
function fakeServer(address: ReturnType<Listenable['server']['address']>): Listenable & { listen: ReturnType<typeof vi.fn> } {
  return { listen: vi.fn(async () => 'ok'), server: { address: () => address } };
}

describe('listenLoopback', () => {
  it('HOST 누락이면 127.0.0.1로 listen하고 주소를 돌려준다', async () => {
    const server = fakeServer({ address: '127.0.0.1', family: 'IPv4', port: 4100 });
    await expect(listenLoopback(server, {}, 4100)).resolves.toMatchObject({ address: '127.0.0.1', port: 4100 });
    expect(server.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4100 });
  });

  it('루프백 외 HOST는 listen을 호출하지 않고 거부한다', async () => {
    const server = fakeServer(null);
    await expect(listenLoopback(server, { HOST: '::' }, 4100)).rejects.toThrow(BindGuardError);
    expect(server.listen).not.toHaveBeenCalled();
    expect(() => resolveListenHost({ HOST: '0.0.0.0' })).toThrow(BindGuardError);
  });

  it('listen 뒤 실제 주소가 루프백이 아니면(파이프·null 포함) 거부한다', async () => {
    for (const address of [null, '/tmp/sock', { address: '0.0.0.0', family: 'IPv4', port: 1 }] as const) {
      await expect(listenLoopback(fakeServer(address), {}, 1)).rejects.toThrow(BindGuardError);
    }
  });
});
