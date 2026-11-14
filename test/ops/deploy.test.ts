import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploySite, type Run } from '../../src/ops/deploy.js';
import { ACCOUNT, OTHER_ACCOUNT } from '../dev/fake-cognito.js';
import { POOL_ID } from '../helpers.js';

/** Built at runtime so the repo holds no Amplify-app-shaped literal (the hygiene test). */
const APP_ID = ['d1test', 'app00001'].join('');
const ROLE = `arn:aws:iam::${ACCOUNT}:role/reports-amplify-service`;
const COMPUTE = `arn:aws:iam::${ACCOUNT}:role/reports-compute`;
const WEB_ACL = `arn:aws:wafv2:us-east-1:${ACCOUNT}:regional/webacl/shared/abc`;

/** A fake of the AWS account, GitHub, and Amplify, as the aws and gh CLIs answer. */
function fakeCloud(start: Partial<{ account: string; repo: boolean; role: boolean; app: boolean; branchOrigin: string; built: boolean; computeAttached: boolean; domain: string }> = {}) {
  const state = { account: ACCOUNT, repo: false, role: false, app: false, branchOrigin: undefined as string | undefined, built: false, computeAttached: false, domain: undefined as string | undefined, ...start };
  const calls: string[][] = [];
  let createAppInput: Record<string, unknown> | undefined;
  const ok = (body: unknown = {}) => ({ code: 0, output: JSON.stringify(body) });
  const fail = (message: string) => ({ code: 254, output: message });
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    const a = args.join(' ');
    if (command === 'gh' && a.startsWith('repo view')) return state.repo ? ok({ name: 'reports' }) : fail('GraphQL: Could not resolve to a Repository');
    if (command === 'gh' && a.startsWith('repo create')) return ((state.repo = true), ok());
    if (command === 'gh' && a === 'auth token') return { code: 0, output: 'gho_test_token_not_real\n' };
    if (command === 'git') return ok();
    if (command === 'npx' && args[0] === 'ampx') {
      if (!state.built) return fail('No deployed backend');
      const dir = args[args.indexOf('--out-dir') + 1]!;
      await writeFile(join(dir, 'amplify_outputs.json'), JSON.stringify({ auth: { user_pool_id: POOL_ID, aws_region: 'us-east-1' }, custom: { computeRoleArn: COMPUTE } }));
      return ok();
    }
    if (command !== 'aws') return fail(`unexpected ${command}`);
    expect(args).toEqual(expect.arrayContaining(['--profile', 'personal', '--region', 'us-east-1']));
    const [service, op] = args;
    switch (`${service} ${op}`) {
      case 'sts get-caller-identity':
        return ok({ Account: state.account });
      case 'iam get-role':
        return state.role ? ok({ Role: { Arn: ROLE } }) : fail('NoSuchEntity');
      case 'iam create-role':
        return ((state.role = true), ok({ Role: { Arn: ROLE } }));
      case 'iam attach-role-policy':
        return ok();
      case 'amplify get-app':
        return state.app ? ok({ app: { appId: APP_ID, ...(state.computeAttached && { computeRoleArn: COMPUTE }) } }) : fail('NotFoundException');
      case 'amplify create-app': {
        const file = args[args.indexOf('--cli-input-json') + 1]!.replace('file://', '');
        createAppInput = JSON.parse(await readFile(file, 'utf8'));
        state.app = true;
        return ok({ app: { appId: APP_ID } });
      }
      case 'amplify get-branch':
        return state.branchOrigin !== undefined ? ok({ branch: { environmentVariables: { APP_ORIGIN: state.branchOrigin } } }) : fail('NotFoundException');
      case 'amplify create-branch':
      case 'amplify update-branch':
        state.branchOrigin = args[args.indexOf('--environment-variables') + 1]!.replace('APP_ORIGIN=', '');
        return ok();
      case 'amplify start-job':
        state.built = true;
        return ok({ jobSummary: { jobId: String(calls.filter((c) => c[2] === 'start-job').length) } });
      case 'amplify get-job':
        return ok({ job: { summary: { status: 'SUCCEED' } } });
      case 'amplify update-app':
        state.computeAttached = true;
        return ok();
      case 'amplify get-domain-association':
        if (!state.domain) return fail('NotFoundException');
        return ok({
          domainAssociation: {
            domainStatus: state.domain,
            certificateVerificationDNSRecord: '_abc123.reports.example.org. CNAME _def456.acm-validations.aws.',
            subDomains: [{ dnsRecord: ' CNAME d1cdn.cloudfront.net', verified: false }],
          },
        });
      case 'amplify create-domain-association':
        state.domain = 'PENDING_VERIFICATION';
        return ok();
      default:
        return fail(`unexpected aws ${service} ${op}`);
    }
  };
  return { run, calls, state, createAppInput: () => createAppInput };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-kit-deploy-test-'));
  await writeFile(join(dir, 'deploy.config.json'), `${JSON.stringify({ awsProfile: 'personal', awsAccountId: ACCOUNT, region: 'us-east-1', amplifyAppId: null, webAcl: WEB_ACL }, null, 2)}\n`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { repo: 'example/reports', domain: 'reports.example.org', sleep: () => Promise.resolve() };
const WRITES = ['create', 'attach-role-policy', 'create-app', 'create-branch', 'update-branch', 'start-job', 'update-app', 'create-domain-association'];

describe('auth-kit deploy', () => {
  it('without --yes reads and prints the plan, and changes nothing', async () => {
    const cloud = fakeCloud();
    const lines: string[] = [];
    const report = await deploySite({ ...base, cwd: dir, run: cloud.run, log: (l) => lines.push(l) });
    expect(report.steps.map((s) => [s.id, s.state])).toEqual([
      ['account', 'done'],
      ['repo', 'todo'],
      ['service-role', 'todo'],
      ['app', 'todo'],
      ['branch', 'todo'],
      ['build', 'todo'],
      ['compute-role', 'todo'],
      ['domain', 'todo'],
      ['owner', 'todo'],
    ]);
    expect(cloud.calls.filter((c) => WRITES.includes(c[2] ?? '') || (c[0] === 'gh' && c[2] === 'create'))).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'deploy.config.json'), 'utf8')).amplifyAppId).toBeNull();
    expect(lines[0]).toMatch(/^✓ AWS account/);
  });

  it('with --yes does each step in order, keeps the token off the command line, and stops at the DNS records', async () => {
    const cloud = fakeCloud();
    const owner = vi.fn(() => Promise.resolve('made'));
    const report = await deploySite({ ...base, cwd: dir, run: cloud.run, yes: true, owner });
    expect(report.steps.map((s) => [s.id, s.state])).toEqual([
      ['account', 'done'],
      ['repo', 'done'],
      ['service-role', 'done'],
      ['app', 'done'],
      ['branch', 'done'],
      ['build', 'done'],
      ['compute-role', 'done'],
      ['domain', 'waiting'],
      ['owner', 'todo'],
    ]);
    expect(report.complete).toBe(false);
    expect(report.dnsRecords).toEqual([
      { type: 'CNAME', name: '_abc123.reports.example.org', value: '_def456.acm-validations.aws' },
      { type: 'CNAME', name: 'reports.example.org', value: 'd1cdn.cloudfront.net' },
    ]);
    // The token went to Amplify in a file, never as an argument, and the file is gone.
    expect(cloud.createAppInput()).toMatchObject({ name: 'reports', repository: 'https://github.com/example/reports', accessToken: 'gho_test_token_not_real', platform: 'WEB_COMPUTE', iamServiceRoleArn: ROLE });
    expect(cloud.calls.flat().join(' ')).not.toContain('gho_test_token_not_real');
    const inputArg = cloud.calls.find((c) => c[2] === 'create-app')!.find((a) => a.startsWith('file://'))!;
    expect(existsSync(inputArg.replace('file://', ''))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'deploy.config.json'), 'utf8')).amplifyAppId).toBe(APP_ID);
    expect(cloud.state.branchOrigin).toBe('https://reports.example.org');
    expect(cloud.state.computeAttached).toBe(true);
    // Built twice: the first deploy, then again so the server runs with the compute role.
    expect(cloud.calls.filter((c) => c[2] === 'start-job')).toHaveLength(2);
    expect(owner).not.toHaveBeenCalled();
  });

  it('run again once the address is live: everything is done, and the owner is invited on the final address', async () => {
    await writeFile(join(dir, 'deploy.config.json'), JSON.stringify({ awsProfile: 'personal', awsAccountId: ACCOUNT, region: 'us-east-1', amplifyAppId: APP_ID, webAcl: WEB_ACL }));
    const cloud = fakeCloud({ repo: true, role: true, app: true, branchOrigin: 'https://reports.example.org', built: true, computeAttached: true, domain: 'AVAILABLE' });
    const owner = vi.fn(() => Promise.resolve('made owner@example.org the owner'));
    const report = await deploySite({ ...base, cwd: dir, run: cloud.run, yes: true, owner });
    expect(report.complete).toBe(true);
    expect(owner).toHaveBeenCalledWith({ userPoolId: POOL_ID, region: 'us-east-1', profile: 'personal', accountId: ACCOUNT, signInUrl: 'https://reports.example.org/sign-in' });
    expect(cloud.calls.filter((c) => c[2] === 'start-job')).toHaveLength(0);
  });

  it('an owner who has already signed in counts as done on a later run', async () => {
    await writeFile(join(dir, 'deploy.config.json'), JSON.stringify({ awsProfile: 'personal', awsAccountId: ACCOUNT, region: 'us-east-1', amplifyAppId: APP_ID, webAcl: WEB_ACL }));
    const cloud = fakeCloud({ repo: true, role: true, app: true, branchOrigin: 'https://reports.example.org', built: true, computeAttached: true, domain: 'AVAILABLE' });
    const owner = vi.fn(() => Promise.reject(new Error('auth-kit owner: owner@example.org has already signed in to this site, so there’s nothing to invite. It is the owner.')));
    const report = await deploySite({ ...base, cwd: dir, run: cloud.run, yes: true, owner });
    expect(report.complete).toBe(true);
  });

  it('refuses another account before anything else, and needs the final address and the web ACL', async () => {
    const cloud = fakeCloud({ account: OTHER_ACCOUNT });
    const report = await deploySite({ ...base, cwd: dir, run: cloud.run, yes: true });
    expect(report.steps).toEqual([expect.objectContaining({ id: 'account', state: 'blocked' })]);
    expect(cloud.calls).toHaveLength(1);
    await expect(deploySite({ ...base, domain: `main.${APP_ID}.amplifyapp.com`, cwd: dir, run: cloud.run })).rejects.toThrow(/final address/);
    await writeFile(join(dir, 'deploy.config.json'), JSON.stringify({ awsProfile: 'personal', awsAccountId: ACCOUNT, region: 'us-east-1', amplifyAppId: null, webAcl: null }));
    await expect(deploySite({ ...base, cwd: dir, run: cloud.run })).rejects.toThrow(/webAcl/);
  });
});

describe('npx auth-kit deploy', () => {
  it('prints the plan without --yes, and the DNS records to add with it', async () => {
    const { runCli } = await import('../../src/dev/cli.js');
    const cloud = fakeCloud();
    const out: string[] = [];
    const io = { cwd: dir, env: {}, out: (l: string) => out.push(l), err: (l: string) => out.push(l), run: cloud.run };
    expect(await runCli(['deploy', '--repo', 'example/reports'], io)).toBe(2);
    expect(await runCli(['deploy', '--repo', 'example/reports', '--domain', 'reports.example.org'], io)).toBe(0);
    expect(out.at(-1)).toBe('That is the plan. Nothing was changed. Run again with --yes to do it.');
    out.length = 0;
    expect(await runCli(['deploy', '--repo', 'example/reports', '--domain', 'reports.example.org', '--yes'], { ...io, sleep: () => Promise.resolve() }), out.join('\n')).toBe(0);
    expect(out).toContain('  CNAME  _abc123.reports.example.org  →  _def456.acm-validations.aws');
    expect(out.at(-1)).toMatch(/^Not finished yet/);
  });
});
