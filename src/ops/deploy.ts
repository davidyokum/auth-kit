/**
 * `npx auth-kit deploy`: puts a site made from the template online, end to end, in the order that
 * keeps the first sign-in simple: the final address is live (so passkeys work) before the owner is
 * invited.
 *
 * Every step reads first and skips what already exists, so the command can be run again at any point:
 * after the DNS records are added, after a failed build, or months later to add the owner again.
 * Without `--yes` it only reads and prints the plan; that list is what the person approves, once.
 *
 *   1. AWS account check (sts get-caller-identity matches deploy.config.json)
 *   2. GitHub repository (gh repo create --private, or push the branch to the one that exists)
 *   3. Amplify service role (`<app>-amplify-service`, AdministratorAccess-Amplify, trusted by Amplify)
 *   4. Amplify app (WEB_COMPUTE, connected to the repository with the gh token; id saved to deploy.config.json)
 *   5. The branch (production stage, auto-build, APP_ORIGIN = the final address)
 *   6. First build (start-job, waits for it)
 *   7. Compute role (the backend's `custom.computeRoleArn`, attached to the app), then a rebuild
 *   8. The final address (domain association; prints the DNS records to add, DNS only, and waits)
 *   9. The owner (`auth-kit owner`), only once the address is live
 *
 * It shells out to `aws` and `gh` (never the SDK for these), with `--profile` always explicit.
 * The GitHub token goes to `aws amplify create-app` in a 0600 file that is deleted afterwards,
 * never on a command line.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Run = (command: string, args: readonly string[], options?: { input?: string }) => Promise<{ code: number; output: string }>;

export interface DeployConfig {
  awsProfile: string;
  awsAccountId: string;
  region: string;
  amplifyAppId: string | null;
  webAcl: string | null;
}

export interface DeployOptions {
  cwd: string;
  run: Run;
  /** `owner/name` on GitHub. */
  repo: string;
  /** The site's final address, e.g. `reports.example.org` (passkeys are bound to it). */
  domain: string;
  /** Default `main`. */
  branch?: string;
  /** Default: the repository's name. */
  appName?: string;
  /** Execute; without it, read and print the plan only. */
  yes?: boolean;
  /** Makes the owner once the address is live (`createOwner` with the branch's pool). Absent: the step is listed and left. */
  owner?: (input: { userPoolId: string; region: string; profile: string; accountId: string; signInUrl: string }) => Promise<string>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a build. Default 30 minutes. */
  buildTimeoutMs?: number;
  /** How long to wait for the address once its records are in. Default 0: print the records and stop (run again later). */
  domainWaitMs?: number;
}

export interface DeployStep {
  id: 'account' | 'repo' | 'service-role' | 'app' | 'branch' | 'build' | 'compute-role' | 'domain' | 'owner';
  title: string;
  state: 'done' | 'todo' | 'waiting' | 'blocked';
  detail?: string;
}

export interface DeployReport {
  steps: DeployStep[];
  /** DNS records to add at the DNS host, when the address waits on them. */
  dnsRecords: { type: string; name: string; value: string }[];
  /** True once every step is done. */
  complete: boolean;
}

const AMPLIFY_POLICY = 'arn:aws:iam::aws:policy/AdministratorAccess-Amplify';

function assertConfig(config: DeployConfig): void {
  if (!config.awsProfile) throw new Error('auth-kit deploy: deploy.config.json needs awsProfile.');
  if (!/^\d{12}$/.test(config.awsAccountId) || /^0+$/.test(config.awsAccountId)) throw new Error('auth-kit deploy: deploy.config.json needs the real 12-digit awsAccountId.');
  if (!config.region) throw new Error('auth-kit deploy: deploy.config.json needs region.');
  if (!config.webAcl) throw new Error('auth-kit deploy: deploy.config.json needs webAcl (the account’s shared web ACL): a branch deploy fails synthesis without it.');
}

function checkedDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) || d.endsWith('.amplifyapp.com')) {
    throw new Error(`auth-kit deploy: --domain must be the site's final address, such as reports.example.org (got "${domain}"). Passkeys are bound to it, so it comes before the first sign-in.`);
  }
  return d;
}

export async function deploySite(options: DeployOptions): Promise<DeployReport> {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const branch = options.branch ?? 'main';
  const domain = checkedDomain(options.domain);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.repo)) throw new Error('auth-kit deploy: --repo must be owner/name on GitHub.');
  const appName = options.appName ?? options.repo.split('/')[1]!;
  const configPath = join(options.cwd, 'deploy.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as DeployConfig;
  assertConfig(config);
  const steps: DeployStep[] = [];
  const dnsRecords: DeployReport['dnsRecords'] = [];
  const report = (): DeployReport => ({ steps, dnsRecords, complete: steps.length === 9 && steps.every((s) => s.state === 'done') });
  const step = (s: DeployStep) => {
    steps.push(s);
    log(`${s.state === 'done' ? '✓' : s.state === 'waiting' ? '…' : s.state === 'blocked' ? '✗' : options.yes ? '→' : '○'} ${s.title}${s.detail ? `: ${s.detail}` : ''}`);
  };
  const aws = async (args: readonly string[], input?: { allowFail?: boolean }) => {
    const result = await options.run('aws', [...args, '--profile', config.awsProfile, '--region', config.region, '--output', 'json']);
    if (result.code !== 0 && !input?.allowFail) throw new Error(`auth-kit deploy: aws ${args.slice(0, 2).join(' ')} failed:\n${result.output.trim().split('\n').slice(-6).join('\n')}`);
    return result;
  };
  const json = <T>(output: string): T => JSON.parse(output || '{}') as T;
  /** A read that may find nothing: the parsed answer, or `{}` when the call failed (not found). */
  const lookup = async <T>(args: readonly string[]): Promise<Partial<T>> => {
    const result = await aws(args, { allowFail: true });
    return result.code === 0 ? json<T>(result.output) : {};
  };

  // 1. The account.
  const identity = json<{ Account?: string }>((await aws(['sts', 'get-caller-identity'])).output);
  if (identity.Account !== config.awsAccountId) {
    step({ id: 'account', title: 'AWS account', state: 'blocked', detail: `profile "${config.awsProfile}" reaches ${identity.Account ?? 'nothing'}, not ${config.awsAccountId}. Nothing was changed.` });
    return report();
  }
  step({ id: 'account', title: 'AWS account', state: 'done', detail: `${config.awsAccountId} through profile "${config.awsProfile}"` });

  // 2. The repository.
  const repoView = await options.run('gh', ['repo', 'view', options.repo, '--json', 'name,visibility']);
  if (repoView.code === 0) {
    step({ id: 'repo', title: `GitHub repository ${options.repo}`, state: options.yes ? 'done' : 'todo', detail: options.yes ? `exists; pushed ${branch}` : `exists; push ${branch} to it` });
    if (options.yes) {
      const push = await options.run('git', ['push', '-u', 'origin', branch]);
      if (push.code !== 0) throw new Error(`auth-kit deploy: git push failed:\n${push.output.trim().split('\n').slice(-6).join('\n')}`);
    }
  } else {
    step({ id: 'repo', title: `GitHub repository ${options.repo}`, state: options.yes ? 'done' : 'todo', detail: options.yes ? 'created (private) and pushed' : 'create it, private, and push this folder' });
    if (options.yes) {
      const created = await options.run('gh', ['repo', 'create', options.repo, '--private', '--source', '.', '--remote', 'origin', '--push']);
      if (created.code !== 0) throw new Error(`auth-kit deploy: gh repo create failed:\n${created.output.trim().split('\n').slice(-6).join('\n')}`);
    }
  }

  // 3. The service role.
  const roleName = `${appName}-amplify-service`.slice(0, 64);
  let roleArn = (await lookup<{ Role: { Arn?: string } }>(['iam', 'get-role', '--role-name', roleName])).Role?.Arn;
  if (roleArn) step({ id: 'service-role', title: `Amplify service role ${roleName}`, state: 'done' });
  else {
    step({ id: 'service-role', title: `Amplify service role ${roleName}`, state: options.yes ? 'done' : 'todo', detail: 'create it: trusted by Amplify, with AdministratorAccess-Amplify (Gen 2 backend deploys)' });
    if (options.yes) {
      const trust = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'amplify.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
      roleArn = json<{ Role: { Arn: string } }>(
        (await aws(['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', trust, '--description', `Amplify Gen 2 deploys for ${appName} (auth-kit deploy)`, '--tags', `Key=app,Value=${appName}`, 'Key=created-by,Value=auth-kit-deploy'])).output,
      ).Role.Arn;
      await aws(['iam', 'attach-role-policy', '--role-name', roleName, '--policy-arn', AMPLIFY_POLICY]);
    }
  }

  // 4. The app.
  let appId = config.amplifyAppId;
  if (appId) {
    const app = await aws(['amplify', 'get-app', '--app-id', appId], { allowFail: true });
    if (app.code !== 0) throw new Error(`auth-kit deploy: deploy.config.json names Amplify app ${appId}, which this account doesn't have. Fix amplifyAppId (or set it to null to create one).`);
    step({ id: 'app', title: `Amplify app ${appId}`, state: 'done' });
  } else {
    step({ id: 'app', title: `Amplify app "${appName}"`, state: options.yes ? 'done' : 'todo', detail: 'create it (WEB_COMPUTE, connected to the repository with your gh sign-in), and save its id in deploy.config.json' });
    if (options.yes) {
      const token = (await options.run('gh', ['auth', 'token'])).output.trim();
      if (!token) throw new Error('auth-kit deploy: gh has no token (run gh auth login).');
      const dir = await mkdtemp(join(tmpdir(), 'auth-kit-deploy-'));
      const inputFile = join(dir, 'create-app.json');
      try {
        await writeFile(
          inputFile,
          JSON.stringify({ name: appName, repository: `https://github.com/${options.repo}`, accessToken: token, platform: 'WEB_COMPUTE', iamServiceRoleArn: roleArn, tags: { app: appName, 'created-by': 'auth-kit-deploy' } }),
          { mode: 0o600 },
        );
        appId = json<{ app: { appId: string } }>((await aws(['amplify', 'create-app', '--cli-input-json', `file://${inputFile}`])).output).app.appId;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      config.amplifyAppId = appId;
      const original = await readFile(configPath, 'utf8');
      await writeFile(configPath, original.replace(/"amplifyAppId":\s*null/, `"amplifyAppId": "${appId}"`));
    }
  }

  // 5. The branch.
  const origin = `https://${domain}`;
  const branchInfo = appId ? (await lookup<{ branch: { environmentVariables?: Record<string, string> } }>(['amplify', 'get-branch', '--app-id', appId, '--branch-name', branch])).branch : undefined;
  if (branchInfo && branchInfo.environmentVariables?.APP_ORIGIN === origin) step({ id: 'branch', title: `Branch ${branch}`, state: 'done', detail: `APP_ORIGIN ${origin}` });
  else {
    step({ id: 'branch', title: `Branch ${branch}`, state: options.yes ? 'done' : 'todo', detail: `${branchInfo ? 'set' : 'connect it (production, auto-build) with'} APP_ORIGIN=${origin}` });
    if (options.yes) {
      const env = `APP_ORIGIN=${origin}`;
      if (branchInfo) await aws(['amplify', 'update-branch', '--app-id', appId!, '--branch-name', branch, '--environment-variables', env]);
      else await aws(['amplify', 'create-branch', '--app-id', appId!, '--branch-name', branch, '--stage', 'PRODUCTION', '--framework', 'Next.js - SSR', '--enable-auto-build', '--environment-variables', env]);
    }
  }

  const build = async (why: string) => {
    const job = json<{ jobSummary: { jobId: string } }>((await aws(['amplify', 'start-job', '--app-id', appId!, '--branch-name', branch, '--job-type', 'RELEASE', '--job-reason', why])).output).jobSummary.jobId;
    log(`  build ${job} started (${why}); waiting`);
    const deadline = Date.now() + (options.buildTimeoutMs ?? 30 * 60 * 1000);
    for (;;) {
      const status = json<{ job: { summary: { status: string } } }>((await aws(['amplify', 'get-job', '--app-id', appId!, '--branch-name', branch, '--job-id', job])).output).job.summary.status;
      if (status === 'SUCCEED') return job;
      if (['FAILED', 'CANCELLED'].includes(status)) throw new Error(`auth-kit deploy: build ${job} ${status.toLowerCase()}. Read its log in the Amplify console, fix it, push, and run this again.`);
      if (Date.now() > deadline) throw new Error(`auth-kit deploy: build ${job} is still ${status.toLowerCase()} after the wait. Run this again once it finishes.`);
      await sleep(20_000);
    }
  };

  // 6–7. The first build, the outputs, and the compute role.
  const outputsDir = await mkdtemp(join(tmpdir(), 'auth-kit-outputs-'));
  let outputs: { auth?: { user_pool_id?: string; aws_region?: string }; custom?: { computeRoleArn?: string } } | undefined;
  try {
    const readOutputs = async () => {
      if (!appId) return undefined;
      const generated = await options.run('npx', ['ampx', 'generate', 'outputs', '--app-id', appId, '--branch', branch, '--out-dir', outputsDir, '--profile', config.awsProfile]);
      if (generated.code !== 0) return undefined;
      return JSON.parse(await readFile(join(outputsDir, 'amplify_outputs.json'), 'utf8')) as typeof outputs;
    };
    outputs = await readOutputs();
    if (outputs?.auth?.user_pool_id) step({ id: 'build', title: 'First build', state: 'done', detail: `pool ${outputs.auth.user_pool_id}` });
    else {
      step({ id: 'build', title: 'First build', state: options.yes ? 'done' : 'todo', detail: 'deploy the branch (backend, then the site), and wait' });
      if (options.yes) {
        await build('auth-kit deploy: first build');
        outputs = await readOutputs();
        if (!outputs?.auth?.user_pool_id) throw new Error('auth-kit deploy: the build finished, but its outputs have no user pool. Check the backend deployed.');
      }
    }
    const computeRoleArn = outputs?.custom?.computeRoleArn;
    const app = appId ? (await lookup<{ app: { computeRoleArn?: string } }>(['amplify', 'get-app', '--app-id', appId])).app : undefined;
    if (computeRoleArn && app?.computeRoleArn === computeRoleArn) step({ id: 'compute-role', title: 'Compute role', state: 'done' });
    else {
      step({ id: 'compute-role', title: 'Compute role', state: options.yes ? 'done' : 'todo', detail: "attach the backend's custom.computeRoleArn to the app, then rebuild so the server runs with it" });
      if (options.yes) {
        if (!computeRoleArn) throw new Error('auth-kit deploy: the outputs have no custom.computeRoleArn (amplify/backend.ts adds it).');
        await aws(['amplify', 'update-app', '--app-id', appId!, '--compute-role-arn', computeRoleArn]);
        await build('auth-kit deploy: the compute role');
      }
    }
  } finally {
    await rm(outputsDir, { recursive: true, force: true });
  }

  // 8. The address.
  type Association = { domainStatus?: string; certificateVerificationDNSRecord?: string; subDomains?: { dnsRecord?: string; verified?: boolean }[] };
  const association = appId ? (await lookup<{ domainAssociation: Association }>(['amplify', 'get-domain-association', '--app-id', appId, '--domain-name', domain])).domainAssociation : undefined;
  let status = association?.domainStatus;
  if (!association && options.yes) {
    await aws(['amplify', 'create-domain-association', '--app-id', appId!, '--domain-name', domain, '--sub-domain-settings', `prefix=,branchName=${branch}`]);
    status = 'CREATING';
  }
  const deadline = Date.now() + (options.domainWaitMs ?? 0);
  // Amplify takes a minute or two to issue the certificate request; wait that long for the records.
  const hardStop = Date.now() + Math.max(options.domainWaitMs ?? 0, 5 * 60 * 1000);
  let records = association;
  while (options.yes && status !== 'AVAILABLE' && status !== 'FAILED') {
    records = json<{ domainAssociation?: Association }>((await aws(['amplify', 'get-domain-association', '--app-id', appId!, '--domain-name', domain])).output).domainAssociation;
    status = records?.domainStatus;
    if (status === 'AVAILABLE' || status === 'FAILED') break;
    if ((records?.certificateVerificationDNSRecord && Date.now() >= deadline) || Date.now() > hardStop) break;
    await sleep(15_000);
  }
  const parseRecord = (r: string | undefined) => {
    // "name TYPE value"; Amplify leaves the name empty (a leading space) for the bare address.
    const [name = '', type, ...value] = (r ?? '').replace(/\s+$/, '').split(/ +/);
    return type && value.length > 0 ? { type, name: name.replace(/\.$/, ''), value: value.join(' ').replace(/\.$/, '') } : null;
  };
  if (status === 'AVAILABLE') step({ id: 'domain', title: `Address ${domain}`, state: 'done' });
  else if (status === 'FAILED') step({ id: 'domain', title: `Address ${domain}`, state: 'blocked', detail: 'Amplify says the domain failed. Check the records, then delete the association in the console and run this again.' });
  else if (!options.yes && !association) step({ id: 'domain', title: `Address ${domain}`, state: 'todo', detail: 'associate it with the branch, then print the two DNS records to add (DNS only, not proxied)' });
  else {
    const cert = parseRecord(records?.certificateVerificationDNSRecord);
    if (cert) dnsRecords.push(cert);
    for (const sub of records?.subDomains ?? []) {
      const r = parseRecord(sub.dnsRecord);
      if (r) dnsRecords.push({ ...r, name: r.name || domain });
    }
    step({ id: 'domain', title: `Address ${domain}`, state: 'waiting', detail: `${(status ?? 'pending').toLowerCase().replace(/_/g, ' ')}; add the DNS records below, then run this again` });
  }

  // 9. The owner.
  const poolId = outputs?.auth?.user_pool_id;
  if (status !== 'AVAILABLE' || !poolId) step({ id: 'owner', title: 'The owner', state: 'todo', detail: 'once the address is live: make the owner and email them the first-visit invite' });
  else if (!options.owner) step({ id: 'owner', title: 'The owner', state: 'todo', detail: 'run npm run owner (or npx auth-kit owner) now that the address is live' });
  else if (!options.yes) step({ id: 'owner', title: 'The owner', state: 'todo', detail: 'make the owner and email them the first-visit invite' });
  else {
    try {
      const outcome = await options.owner({ userPoolId: poolId, region: outputs?.auth?.aws_region ?? config.region, profile: config.awsProfile, accountId: config.awsAccountId, signInUrl: `${origin}/sign-in` });
      step({ id: 'owner', title: 'The owner', state: 'done', detail: outcome });
    } catch (error) {
      // Run again after the owner signed in: that's done, not a failure.
      const message = error instanceof Error ? error.message : String(error);
      if (/has already signed in|already has an owner/.test(message)) step({ id: 'owner', title: 'The owner', state: 'done', detail: message.replace(/^auth-kit owner: /, '') });
      else throw error;
    }
  }
  return report();
}
