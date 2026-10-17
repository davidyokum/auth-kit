import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSandboxPool,
  checkDevSignInGates,
  checkProductionBuild,
  createDevSignInHandler,
  defaultPersonas,
  EnvironmentRibbon,
  environmentRibbonModel,
  isLocalhostName,
  NotASandboxPoolError,
  NotImplementedError,
  parsePersonas,
  personaEmail,
  seedPersonas,
} from '../../src/dev/index.js';

describe('the three gates', () => {
  const combos = [
    ['development', 'localhost:3000', '1', true],
    ['production', 'localhost:3000', '1', false],
    ['test', 'localhost:3000', '1', false],
    [undefined, 'localhost:3000', '1', false],
    ['development', 'app.example.org', '1', false],
    ['development', 'localhost:3000', undefined, false],
    ['development', 'localhost:3000', 'true', false],
    ['development', 'localhost:3000', '0', false],
    ['production', 'app.example.org', undefined, false],
  ] as const;
  it.each(combos)('NODE_ENV=%s host=%s flag=%s -> %s', (nodeEnv, host, flag, allowed) => {
    expect(checkDevSignInGates({ nodeEnv, host, flag }).allowed).toBe(allowed);
  });

  it('names every failed gate', () => {
    expect(checkDevSignInGates({ nodeEnv: 'production', host: 'evil.example', flag: undefined }).failed).toEqual(['nodeEnv', 'host', 'flag']);
  });
});

describe('isLocalhostName', () => {
  it.each([
    ['localhost', true],
    ['localhost:3000', true],
    ['LOCALHOST', true],
    ['app.localhost', true],
    ['admin.app.localhost:3001', true],
    ['localhost.', true],
    ['localhost.example.org', false],
    ['evil-localhost', false],
    ['evillocalhost', false],
    ['127.0.0.1', false],
    ['[::1]', false],
    ['a..localhost', false],
    ['-x.localhost', false],
    ['localhost:3000:1', false],
    ['localhost/evil', false],
    ['', false],
    [null, false],
  ])('%s -> %s', (host, ok) => {
    expect(isLocalhostName(host)).toBe(ok);
  });
});

describe('dev sign-in handler (phase 1 shell)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const handler = createDevSignInHandler({ userPoolId: 'us-east-1_TestPool1', clientId: 'c', passwords: () => ({}) });

  it('answers 404 unless all three gates pass', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_DEV_SIGNIN', '1');
    expect((await handler(new Request('http://localhost:3000/dev/sign-in', { headers: { host: 'localhost:3000' } }))).status).toBe(404);
    vi.stubEnv('NODE_ENV', 'development');
    expect((await handler(new Request('http://localhost:3000/dev/sign-in', { headers: { host: 'app.example.org' } }))).status).toBe(404);
    vi.stubEnv('ALLOW_DEV_SIGNIN', '');
    expect((await handler(new Request('http://localhost:3000/dev/sign-in', { headers: { host: 'localhost:3000' } }))).status).toBe(404);
  });

  it('answers 501 (not implemented) when every gate passes', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_DEV_SIGNIN', '1');
    const res = await handler(new Request('http://app.localhost:3000/dev/sign-in', { headers: { host: 'app.localhost:3000' } }));
    expect(res.status).toBe(501);
  });
});

describe('sandbox guard', () => {
  it('passes only a pool tagged Environment=sandbox', () => {
    expect(() => assertSandboxPool('p', { Environment: 'sandbox' })).not.toThrow();
    expect(() => assertSandboxPool('p', { Environment: 'main' })).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', { Environment: 'branch-sandbox' })).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', {})).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', undefined)).toThrow(NotASandboxPoolError);
  });
});

describe('personas', () => {
  it('defaults to one persona per role plus a member, all on .test', () => {
    expect(defaultPersonas().map((p) => p.email)).toEqual([
      'superadmin@personas.test',
      'admin@personas.test',
      'editor@personas.test',
      'viewer@personas.test',
      'member@personas.test',
    ]);
    expect(personaEmail('editor')).toBe('editor@personas.test');
    expect(parsePersonas(defaultPersonas())).toHaveLength(5);
  });

  it('rejects real-looking addresses, duplicates, missing roles, and admin roles hidden in appRoles', () => {
    const base = defaultPersonas();
    expect(() => parsePersonas(base.map((p, i) => (i === 0 ? { ...p, email: 'owner@gmail.com' } : p)))).toThrow(/\.test/);
    expect(() => parsePersonas([...base, { role: 'admin', email: 'admin2@personas.test' }])).toThrow(/second "admin"/);
    expect(() => parsePersonas(base.slice(1))).toThrow(/no "superadmin" persona/);
    expect(() => parsePersonas(base.map((p, i) => (i === 4 ? { ...p, appRoles: ['admin'] } : p)))).toThrow(/can't include admin roles/);
    expect(() => parsePersonas({})).toThrow(/array/);
    expect(() => parsePersonas([...base.slice(0, 4), { ...base[4], email: 'admin@personas.test' }])).toThrow(/duplicate email/);
  });
});

describe('environment ribbon model', () => {
  it('hides on production and shows elsewhere', () => {
    expect(environmentRibbonModel({ environment: 'production', poolId: 'p', poolIsSandbox: false }).show).toBe(false);
    expect(environmentRibbonModel({ environment: 'preview', poolId: 'p', poolIsSandbox: false })).toMatchObject({
      show: true,
      tone: 'preview',
      titlePrefix: '[PREVIEW] ',
    });
  });

  it('names the pool and persona locally, and turns red when a local app points at a non-sandbox pool', () => {
    expect(environmentRibbonModel({ environment: 'local', poolId: 'us-east-1_TestPool1', poolIsSandbox: true, persona: 'Editor' })).toEqual({
      show: true,
      label: 'LOCAL · sandbox pool us-east-1_TestPool1 · signed in as Editor (test)',
      tone: 'local',
      titlePrefix: '[DEV] ',
    });
    expect(environmentRibbonModel({ environment: 'local', poolId: 'p', poolIsSandbox: false }).tone).toBe('danger');
  });
});

describe('phase-2 stubs', () => {
  it('throw or reject NotImplementedError', async () => {
    await expect(seedPersonas({ awsProfile: 'personal', expectedAccountId: '0', userPoolId: 'p', personas: [] })).rejects.toThrow(NotImplementedError);
    await expect(checkProductionBuild({ buildDir: '.next' })).rejects.toThrow(NotImplementedError);
    expect(() => EnvironmentRibbon({ environment: 'local', poolId: 'p', poolIsSandbox: true })).toThrow(NotImplementedError);
  });
});
