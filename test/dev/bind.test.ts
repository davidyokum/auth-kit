import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLoopbackBinding, listeningSockets, probeTcp } from '../../src/dev/index.js';

const handle = (address: string, port = 3000, family = address.includes(':') ? 'IPv6' : 'IPv4') => ({
  listening: true,
  address: () => ({ address, port, family }),
});

describe('the loopback check: listening sockets', () => {
  it.each([
    [[handle('127.0.0.1')], true],
    [[handle('::1')], true],
    [[handle('127.0.0.1'), handle('::1', 3000)], true],
    [[handle('0.0.0.0')], false],
    [[handle('::')], false],
    [[handle('192.168.1.23')], false],
    [[handle('127.0.0.1'), handle('0.0.0.0', 9229)], false],
  ])('%j -> ok %s', async (handles, ok) => {
    const result = await checkLoopbackBinding({ handles: () => handles, probe: () => Promise.reject(new Error('no probe when sockets are visible')) });
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.reason).toMatch(/next dev --hostname 127\.0\.0\.1/);
  });

  it('names the exposed address', async () => {
    const result = await checkLoopbackBinding({ handles: () => [handle('::', 3001)] });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('[::]:3001') });
  });

  it('ignores handles that are not listening servers, and Unix sockets', () => {
    const handles = [
      { listening: false, address: () => ({ address: '0.0.0.0', port: 1 }) },
      { address: () => ({ address: '0.0.0.0', port: 2 }) },
      { listening: true, address: () => '/tmp/next.sock' },
      { listening: true, address: () => {
        throw new Error('closed');
      } },
      null,
      42,
      handle('127.0.0.1', 3000),
    ];
    expect(listeningSockets(handles)).toEqual([{ address: '127.0.0.1', port: 3000 }]);
  });
});

describe('the loopback check: probe fallback', () => {
  it('passes when every network address refuses the dev port', async () => {
    const probed: string[] = [];
    const result = await checkLoopbackBinding({
      handles: () => [],
      port: '3000',
      addresses: () => ['192.168.1.23', '2001:db8::5'],
      probe: (host, port) => {
        probed.push(`${host}:${port}`);
        return Promise.resolve('closed');
      },
    });
    expect(result.ok).toBe(true);
    expect(probed).toEqual(['192.168.1.23:3000', '2001:db8::5:3000']);
  });

  it('fails when a network address answers, or when it can’t tell', async () => {
    expect((await checkLoopbackBinding({ handles: () => [], port: 3000, addresses: () => ['192.168.1.23'], probe: () => Promise.resolve('open') })).ok).toBe(false);
    expect((await checkLoopbackBinding({ handles: () => [], port: 3000, addresses: () => ['192.168.1.23'], probe: () => Promise.resolve('unknown') })).ok).toBe(false);
  });

  it('fails closed with no visible socket and no port', async () => {
    const result = await checkLoopbackBinding({ handles: () => undefined, port: '' });
    expect(result.ok).toBe(false);
  });
});

describe('probeTcp (loopback only)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('reports open for a listening port and closed for a refused one', async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    expect(await probeTcp('127.0.0.1', port)).toBe('open');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(await probeTcp('127.0.0.1', port)).toBe('closed');
  });

  it('sees a real server through the process’s own handles', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    expect(listeningSockets().some((s) => s.port === port && s.address === '127.0.0.1')).toBe(true);
  });
});
