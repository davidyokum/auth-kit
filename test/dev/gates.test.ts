import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDevSignInGates,
  DEV_GATES,
  devGateInputFor,
  devSignInGatesFor,
  forwardedClientAddresses,
  isLocalhostName,
  isLoopbackAddress,
  isLoopbackHost,
  localDevServer,
} from '../../src/dev/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the request gates', () => {
  const combos = [
    ['development', 'localhost:3000', '1', true],
    ['development', '127.0.0.1:3000', '1', true],
    ['development', '[::1]:3000', '1', true],
    ['production', 'localhost:3000', '1', false],
    ['test', 'localhost:3000', '1', false],
    [undefined, 'localhost:3000', '1', false],
    ['development', 'app.example.org', '1', false],
    ['development', 'localhost:3000', undefined, false],
    ['development', 'localhost:3000', 'true', false],
    ['development', 'localhost:3000', '0', false],
    ['development', 'localhost:3000', ' 1', false],
    ['production', 'app.example.org', undefined, false],
  ] as const;
  it.each(combos)('NODE_ENV=%s host=%s flag=%s -> %s', (nodeEnv, host, flag, allowed) => {
    expect(checkDevSignInGates({ nodeEnv, host, flag }).allowed).toBe(allowed);
  });

  it('names every failed gate', () => {
    expect(checkDevSignInGates({ nodeEnv: 'production', host: 'evil.example', flag: undefined, clientAddresses: ['203.0.113.9'] }).failed).toEqual([
      'nodeEnv',
      'host',
      'flag',
      'proxy',
    ]);
  });

  it('documents each gate it checks', () => {
    expect(DEV_GATES.map((g) => g.id)).toEqual(['nodeEnv', 'host', 'flag', 'proxy']);
  });

  it('requires every name the request carries to be loopback, not just Host', () => {
    const ok = { nodeEnv: 'development', host: 'app.localhost:3000', flag: '1' };
    expect(checkDevSignInGates({ ...ok, otherHosts: ['app.localhost:3000', null] }).allowed).toBe(true);
    // A tunnel rewrites Host to localhost but names the public host in X-Forwarded-Host.
    expect(checkDevSignInGates({ ...ok, otherHosts: ['app.localhost:3000', 'abc.ngrok.app'] }).failed).toEqual(['host']);
    expect(checkDevSignInGates({ ...ok, otherHosts: ['orchard.example'] }).failed).toEqual(['host']);
  });

  it('refuses when a proxy header names a client that is not this computer', () => {
    const ok = { nodeEnv: 'development', host: 'localhost:3000', flag: '1' };
    expect(checkDevSignInGates({ ...ok, clientAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] }).allowed).toBe(true);
    expect(checkDevSignInGates({ ...ok, clientAddresses: ['127.0.0.1', '192.168.1.23'] }).failed).toEqual(['proxy']);
    expect(checkDevSignInGates({ ...ok, clientAddresses: ['unknown'] }).failed).toEqual(['proxy']);
  });
});

describe('host spoofing', () => {
  it.each([
    ['localhost', true],
    ['localhost:3000', true],
    ['LOCALHOST', true],
    ['LocalHost:3000', true],
    ['app.localhost', true],
    ['APP.LOCALHOST:3001', true],
    ['admin.app.localhost:3001', true],
    ['localhost.', true],
    ['127.0.0.1', true],
    ['127.0.0.1:3000', true],
    ['[::1]', true],
    ['[::1]:3000', true],
    ['localhost.evil.com', false],
    ['localhost.evil.com:3000', false],
    ['app.localhost.evil.com', false],
    ['evil.com', false],
    ['evil-localhost', false],
    ['evillocalhost', false],
    ['xn--localhost', false],
    ['127.0.0.1.nip.io', false],
    ['127.0.0.2', false],
    ['127.1', false],
    ['2130706433', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['[::1', false],
    ['[0:0:0:0:0:0:0:1]', false],
    ['[::ffff:127.0.0.1]', false],
    ['[::2]:3000', false],
    ['localhost:0', false],
    ['localhost:65536', false],
    ['localhost:99999', false],
    ['localhost:', false],
    ['localhost:3000:1', false],
    ['localhost/evil', false],
    ['user@localhost', false],
    ['localhost#evil.com', false],
    ['localhost,evil.com', false],
    ['localhost evil.com', false],
    ['a..localhost', false],
    ['-x.localhost', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%s -> %s', (host, ok) => {
    expect(isLoopbackHost(host)).toBe(ok);
    expect(checkDevSignInGates({ nodeEnv: 'development', host, flag: '1' }).allowed).toBe(ok);
  });

  it('keeps isLocalhostName to names (no IP literals)', () => {
    expect(isLocalhostName('localhost:3000')).toBe(true);
    expect(isLocalhostName('127.0.0.1')).toBe(false);
    expect(isLocalhostName('[::1]')).toBe(false);
    expect(isLocalhostName('localhost:70000')).toBe(false);
  });
});

describe('loopback client addresses', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.10.20.30', true],
    ['127.0.0.1:51234', true],
    ['::1', true],
    ['[::1]', true],
    ['[::1]:51234', true],
    ['"[::1]:51234"', true],
    ['::ffff:127.0.0.1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['192.168.1.23', false],
    ['10.0.0.5', false],
    ['::ffff:192.168.1.23', false],
    ['127.0.0.256', false],
    ['0127.0.0.1', false],
    ['unknown', false],
    ['_hidden', false],
    ['', false],
  ])('%s -> %s', (address, ok) => {
    expect(isLoopbackAddress(address)).toBe(ok);
  });

  it('reads every proxy header, including RFC 7239 Forwarded', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.9, 127.0.0.1',
      'x-real-ip': '198.51.100.2',
      forwarded: 'for=192.0.2.60;proto=http;by=203.0.113.43, for="[2001:db8:cafe::17]:4711"',
    });
    expect(forwardedClientAddresses(headers)).toEqual(['203.0.113.9', '127.0.0.1', '198.51.100.2', '192.0.2.60', '"[2001:db8:cafe::17]:4711"']);
  });
});

describe('gates for a real request', () => {
  const request = (url: string, headers: Record<string, string>) => new Request(url, { headers });

  it('reads Host, the URL, X-Forwarded-Host, and proxy headers', () => {
    const input = devGateInputFor(
      request('http://app.localhost:3000/api/dev/sign-in', { host: 'app.localhost:3000', 'x-forwarded-host': 'app.localhost:3000', 'x-forwarded-for': '::1' }),
      { NODE_ENV: 'development', ALLOW_DEV_SIGNIN: '1' },
    );
    expect(input).toEqual({
      nodeEnv: 'development',
      host: 'app.localhost:3000',
      flag: '1',
      otherHosts: ['app.localhost:3000', 'app.localhost:3000'],
      clientAddresses: ['::1'],
    });
    expect(checkDevSignInGates(input).allowed).toBe(true);
  });

  it('uses process.env for NODE_ENV and the flag', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_DEV_SIGNIN', '1');
    expect(devSignInGatesFor(request('http://localhost:3000/x', { host: 'localhost:3000' })).allowed).toBe(true);
    // A LAN caller who doesn't forge X-Forwarded-For: Next fills it in with their address.
    expect(devSignInGatesFor(request('http://localhost:3000/x', { host: 'localhost:3000', 'x-forwarded-for': '192.168.1.40' })).failed).toEqual(['proxy']);
    // Host forged to localhost, but the request URL names another host. (Next builds request.url
    // from its own hostname, so there this check adds nothing; other runtimes may differ.)
    expect(devSignInGatesFor(request('http://192.168.1.23:3000/x', { host: 'localhost:3000' })).failed).toEqual(['host']);
    vi.stubEnv('NODE_ENV', 'production');
    expect(devSignInGatesFor(request('http://localhost:3000/x', { host: 'localhost:3000' })).failed).toEqual(['nodeEnv']);
  });
});

describe('localDevServer', () => {
  it('binds to loopback and names the app', () => {
    expect(localDevServer({ app: 'reports', port: 3001 })).toEqual({
      command: 'next dev --hostname 127.0.0.1 --port 3001',
      url: 'http://reports.localhost:3001',
    });
    expect(localDevServer({ app: 'Admin' }).url).toBe('http://admin.localhost:3000');
    expect(() => localDevServer({ app: 'bad_name' })).toThrow(/can't be used/);
    expect(() => localDevServer({ app: 'ok', port: 0 })).toThrow(/out of range/);
  });
});
