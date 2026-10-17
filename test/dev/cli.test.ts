import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../../src/dev/cli.js';
import { DEV_SIGNIN_MARKER, resetPersonaAuthState } from '../../src/dev/index.js';
import { CLIENT_ID, POOL_ID } from '../helpers.js';
import { ACCOUNT, createFakeCognito, type FakeCognito, OTHER_ACCOUNT } from './fake-cognito.js';

let dir: string;
let out: string[];
let err: string[];

function io(extra: Partial<CliIo> = {}): CliIo {
  return { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l), ...extra };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-kit-cli-'));
  out = [];
  err = [];
  resetPersonaAuthState();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('auth-kit help and usage', () => {
  it('prints help, and exits 2 for no command or a bad one', async () => {
    expect(await runCli(['help'], io())).toBe(0);
    expect(out.join('\n')).toMatch(/seed-personas/);
    expect(await runCli([], io())).toBe(2);
    expect(await runCli(['launch-rockets'], io())).toBe(2);
    expect(await runCli(['check-prod-build', '--bogus'], io())).toBe(2);
    expect(err.join('\n')).toMatch(/npx auth-kit help/);
  });
});

describe('auth-kit init-personas', () => {
  it('writes a valid starter file and will not overwrite it without --force', async () => {
    expect(await runCli(['init-personas', '--domain', 'orchard.test', '--app-roles', 'reviewer'], io())).toBe(0);
    const personas = JSON.parse(await readFile(join(dir, 'personas.json'), 'utf8')) as { key: string; email: string }[];
    expect(personas.map((p) => p.email)).toContain('reviewer@orchard.test');
    expect(await runCli(['init-personas'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/--force/);
    expect(await runCli(['init-personas', '--force'], io())).toBe(0);
  });
});

describe('auth-kit seed-personas', () => {
  let fake: FakeCognito;
  beforeEach(async () => {
    fake = createFakeCognito();
    await runCli(['init-personas', '--domain', 'orchard.test'], io());
    await writeFile(
      join(dir, 'amplify_outputs.json'),
      JSON.stringify({ auth: { user_pool_id: POOL_ID, user_pool_client_id: CLIENT_ID, aws_region: 'us-east-1' } }),
    );
    out = [];
    err = [];
  });

  it('refuses to guess an AWS profile, before any AWS call', async () => {
    let created = 0;
    expect(await runCli(['seed-personas'], io({ createClient: () => (created++, fake.client) }))).toBe(1);
    expect(err.join('\n')).toMatch(/won't guess which AWS account/);
    expect(created).toBe(0);
  });

  it('refuses a region that does not match the pool', async () => {
    expect(await runCli(['seed-personas', '--profile', 'personal', '--region', 'us-west-2'], io({ createClient: () => fake.client }))).toBe(1);
    expect(err.join('\n')).toMatch(/is in us-east-1/);
  });

  it('rejects a malformed --account', async () => {
    expect(await runCli(['seed-personas', '--profile', 'personal', '--account', '12345'], io())).toBe(2);
  });

  it('seeds with an explicit profile and account, then reports no changes on a rerun', async () => {
    const clients: { region: string; profile?: string }[] = [];
    const cli = io({ createClient: (input) => (clients.push(input), fake.client), now: fake.now, sleep: fake.sleep });
    // .env.local must be git-ignored; outside a repository there is nothing to commit, so it proceeds.
    expect(await runCli(['seed-personas', '--profile', 'personal', '--account', ACCOUNT], cli)).toBe(0);
    expect(clients).toEqual([{ region: 'us-east-1', profile: 'personal' }]);
    expect(out[0]).toBe(`Using profile "personal", us-east-1, pool ${POOL_ID}.`);
    expect(out.join('\n')).toMatch(/ALLOW_DEV_SIGNIN=1/);
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toMatch(/PERSONA_PASSWORD_EDITOR=/);

    out = [];
    resetPersonaAuthState();
    expect(await runCli(['seed-personas', '--profile', 'personal', '--account', ACCOUNT], cli)).toBe(0);
    expect(out.at(-1)).toMatch(/already up to date/);
  });

  it('refuses the wrong account and writes nothing', async () => {
    expect(await runCli(['seed-personas', '--profile', 'osbm', '--account', OTHER_ACCOUNT], io({ createClient: () => fake.client }))).toBe(1);
    expect(err.join('\n')).toMatch(/not the expected/);
    expect(fake.writeCalls()).toBe(0);
  });

  it('uses AWS_PROFILE when set, and explains a missing personas.json', async () => {
    await rm(join(dir, 'personas.json'));
    expect(await runCli(['seed-personas'], io({ env: { AWS_PROFILE: 'personal' }, createClient: () => fake.client }))).toBe(1);
    expect(err.join('\n')).toMatch(/init-personas/);
  });
});

describe('auth-kit check-prod-build', () => {
  it('exits 0 for a clean build and 1 when dev sign-in shipped, or when there is no build', async () => {
    const build = join(dir, '.next');
    await mkdir(join(build, 'static', 'chunks'), { recursive: true });
    await writeFile(join(build, 'BUILD_ID'), 'x');
    await writeFile(join(build, 'static', 'chunks', 'a.js'), 'clean');
    expect(await runCli(['check-prod-build'], io())).toBe(0);
    expect(out.at(-1)).toMatch(/^OK: no dev sign-in/);

    await writeFile(join(build, 'static', 'chunks', 'b.js'), DEV_SIGNIN_MARKER);
    expect(await runCli(['check-prod-build', '--dir', '.next'], io())).toBe(1);
    expect(err.join('\n')).toMatch(/b\.js: contains the dev sign-in marker/);

    expect(await runCli(['check-prod-build', '--dir', 'nope'], io())).toBe(1);
  });
});

describe('auth-kit check-dev-route', () => {
  it('needs --url', async () => {
    expect(await runCli(['check-dev-route'], io())).toBe(2);
  });
});
