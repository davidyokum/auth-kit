import { AdminSetUserPasswordCommand, AssociateSoftwareTokenCommand, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultPersonas,
  NotASandboxPoolError,
  parseEnvFile,
  resetPersonaAuthState,
  seedPersonas,
  type SeedPersonasOptions,
  signInPersona,
} from '../../src/dev/index.js';
import { CLIENT_ID, POOL_ID } from '../helpers.js';
import { ACCOUNT, createFakeCognito, type FakeCognito, OTHER_ACCOUNT } from './fake-cognito.js';

const personas = defaultPersonas({ domain: 'orchard.test', appRoles: ['reviewer'] });
let dir: string;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-kit-seed-'));
  lines = [];
  resetPersonaAuthState();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(fake: FakeCognito, extra: Partial<SeedPersonasOptions> = {}): SeedPersonasOptions {
  return {
    client: fake.client,
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    personas,
    appRoles: ['reviewer'],
    expectedAccountId: ACCOUNT,
    cwd: dir,
    gitIgnore: () => Promise.resolve('ignored'),
    now: fake.now,
    sleep: fake.sleep,
    log: (line) => lines.push(line),
    ...extra,
  };
}

const envValues = async () => parseEnvFile(await readFile(join(dir, '.env.local'), 'utf8'));

describe('seedPersonas', () => {
  it('creates each persona with a permanent password, its groups, and an authenticator', async () => {
    const fake = createFakeCognito();
    const report = await seedPersonas(options(fake));
    expect(report.unchanged).toBe(false);
    expect(report.personas.map((p) => p.key)).toEqual(['superadmin', 'admin', 'editor', 'viewer', 'member', 'reviewer']);
    expect(report.personas.find((p) => p.key === 'editor')?.actions).toEqual(['created', 'password set', 'added to editor', 'authenticator enrolled']);
    expect(report.personas.find((p) => p.key === 'member')?.actions).toEqual(['created', 'password set', 'authenticator enrolled']);

    const editor = fake.userByEmail('editor@orchard.test')!;
    expect(editor.status).toBe('CONFIRMED');
    expect([...editor.groups]).toEqual(['editor']);
    expect(editor.attributes.get('email_verified')).toBe('true');
    expect(editor.totp?.enabled).toBe(true);

    const env = await envValues();
    expect(env.get('PERSONA_PASSWORD_EDITOR')).toBe(editor.password);
    expect(env.get('PERSONA_TOTP_EDITOR')).toBe(editor.totp?.secret);
    expect(env.get('PERSONA_PASSWORD_EDITOR')!.length).toBeGreaterThanOrEqual(15);
    expect((await stat(join(dir, '.env.local'))).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run makes no writes and proves each persona signs in', async () => {
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    const before = await readFile(join(dir, '.env.local'), 'utf8');
    const writes = fake.writeCalls();
    resetPersonaAuthState(); // a fresh process, as a second `npx auth-kit seed-personas` would be

    const again = await seedPersonas(options(fake));
    expect(again.unchanged).toBe(true);
    expect(again.personas.every((p) => p.actions.join() === 'verified')).toBe(true);
    expect(fake.writeCalls()).toBe(writes);
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toBe(before);
  });

  it('keeps other lines in .env.local and updates its own in place', async () => {
    await writeFile(join(dir, '.env.local'), '# mine\nALLOW_DEV_SIGNIN=1\nAWS_PROFILE=personal\n');
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    const text = await readFile(join(dir, '.env.local'), 'utf8');
    expect(text.startsWith('# mine\nALLOW_DEV_SIGNIN=1\nAWS_PROFILE=personal\n\n# auth-kit personas')).toBe(true);
    expect(text.match(/PERSONA_PASSWORD_EDITOR=/g)).toHaveLength(1);
  });

  it('refuses a pool that is not a sandbox before writing anything', async () => {
    for (const fake of [
      createFakeCognito({ tags: { Environment: 'production' } }),
      createFakeCognito({ tags: { Environment: 'sandbox', 'amplify:deployment-type': 'branch' } }),
      createFakeCognito({ deletionProtection: 'ACTIVE' }),
      createFakeCognito({ estimatedUsers: 5000 }),
    ]) {
      await expect(seedPersonas(options(fake))).rejects.toThrow(NotASandboxPoolError);
      expect(fake.writeCalls()).toBe(0);
      expect(fake.mock.calls().map((c) => c.args[0].constructor.name)).toEqual(['DescribeUserPoolCommand']);
    }
    await expect(stat(join(dir, '.env.local'))).rejects.toThrow();
  });

  it('refuses the wrong AWS account before writing anything', async () => {
    const fake = createFakeCognito({ account: OTHER_ACCOUNT });
    await expect(seedPersonas(options(fake))).rejects.toThrow(/not the expected/);
    expect(fake.writeCalls()).toBe(0);
  });

  it('refuses when .env.local is not git-ignored', async () => {
    const fake = createFakeCognito();
    await expect(seedPersonas(options(fake, { gitIgnore: () => Promise.resolve('not-ignored') }))).rejects.toThrow(/isn't git-ignored/);
    expect(fake.writeCalls()).toBe(0);
  });

  it('refuses an invalid personas.json before calling AWS', async () => {
    const fake = createFakeCognito();
    await expect(seedPersonas(options(fake, { personas: [{ key: 'admin', email: 'me@example.com', groups: ['admin'] }] }))).rejects.toThrow(/personas.json is invalid/);
    expect(fake.mock.calls()).toHaveLength(0);
  });

  it('converges groups: adds missing, removes extras', async () => {
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    fake.userByEmail('viewer@orchard.test')!.groups.add('admin');
    fake.userByEmail('editor@orchard.test')!.groups.delete('editor');
    resetPersonaAuthState();
    const report = await seedPersonas(options(fake));
    expect(report.personas.find((p) => p.key === 'viewer')?.actions).toEqual(['removed from admin', 'verified']);
    expect(report.personas.find((p) => p.key === 'editor')?.actions).toEqual(['added to editor', 'verified']);
    expect([...fake.userByEmail('viewer@orchard.test')!.groups]).toEqual(['viewer']);
  });

  it('repairs drift: a password changed elsewhere, a lost authenticator secret, a disabled persona', async () => {
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    fake.userByEmail('admin@orchard.test')!.password = 'changed-in-the-console-123';
    fake.userByEmail('member@orchard.test')!.enabled = false;
    const env = await envValues();
    const oldSecret = env.get('PERSONA_TOTP_EDITOR');
    await writeFile(join(dir, '.env.local'), [...env].filter(([k]) => k !== 'PERSONA_TOTP_EDITOR').map(([k, v]) => `${k}=${v}`).join('\n'));
    resetPersonaAuthState();

    const report = await seedPersonas(options(fake));
    expect(report.personas.find((p) => p.key === 'admin')?.actions).toEqual(['password set', 'verified']);
    expect(report.personas.find((p) => p.key === 'member')?.actions).toEqual(['enabled', 'verified']);
    expect(report.personas.find((p) => p.key === 'editor')?.actions).toEqual(['authenticator enrolled']);
    const after = await envValues();
    expect(after.get('PERSONA_TOTP_EDITOR')).toBeDefined();
    expect(after.get('PERSONA_TOTP_EDITOR')).not.toBe(oldSecret);
    expect(fake.userByEmail('admin@orchard.test')!.password).toBe(after.get('PERSONA_PASSWORD_ADMIN'));
  });

  it('enrolls through MFA_SETUP in a pool that requires MFA', async () => {
    const fake = createFakeCognito({ mfa: 'ON' });
    await seedPersonas(options(fake));
    expect(fake.userByEmail('editor@orchard.test')!.totp?.enabled).toBe(true);
    resetPersonaAuthState();
    expect((await seedPersonas(options(fake))).unchanged).toBe(true);
  });

  it('skips authenticators when the pool has MFA off, and says so', async () => {
    const fake = createFakeCognito({ mfa: 'OFF' });
    await seedPersonas(options(fake));
    expect(fake.mock.commandCalls(AssociateSoftwareTokenCommand)).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/MFA off/);
  });

  it('dry run: reads the pool and reports, writes nothing anywhere', async () => {
    const fake = createFakeCognito();
    const report = await seedPersonas(options(fake, { dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.unchanged).toBe(false);
    expect(report.personas[0]?.actions).toEqual(['would create', 'would set password', 'would add to superadmin', 'would enroll authenticator']);
    expect(fake.writeCalls()).toBe(0);
    await expect(stat(join(dir, '.env.local'))).rejects.toThrow();
  });

  it('explains a group the pool lacks', async () => {
    const fake = createFakeCognito({ groups: ['superadmin', 'admin', 'editor', 'viewer'] });
    await expect(seedPersonas(options(fake))).rejects.toThrow(/no group "reviewer".*appRoles/);
  });

  it('never logs a password or authenticator secret', async () => {
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    const env = await envValues();
    const secrets = [...env].filter(([k]) => k.startsWith('PERSONA_')).map(([, v]) => v);
    expect(secrets.length).toBe(12);
    for (const s of secrets) expect(lines.join('\n')).not.toContain(s);
  });

  it('leaves personas that "Sign in as…" can use, even within the same 30 seconds', async () => {
    const fake = createFakeCognito();
    await seedPersonas(options(fake));
    const env = await envValues();
    resetPersonaAuthState(); // the dev server is another process: it doesn't know which codes the seed used
    const tokens = await signInPersona({
      client: fake.client,
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      email: 'editor@orchard.test',
      password: env.get('PERSONA_PASSWORD_EDITOR')!,
      totpSecret: env.get('PERSONA_TOTP_EDITOR')!,
      now: fake.now,
      sleep: fake.sleep,
    });
    expect(tokens.username).toBe(fake.userByEmail('editor@orchard.test')!.sub);
    expect(fake.mock.commandCalls(AdminSetUserPasswordCommand).length).toBe(6);
    expect(fake.mock.commandCalls(DescribeUserPoolCommand)).toHaveLength(1);
  });
});
