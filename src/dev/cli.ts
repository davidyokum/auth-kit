/**
 * `npx auth-kit <command>`: the localhost kit's command line.
 *
 *   init-personas      write a starter personas.json
 *   seed-personas      create or update the personas in your sandbox pool
 *   check-prod-build   fail if a production build contains dev sign-in
 *   check-dev-route    fail unless a running production build answers the dev route with 404
 */
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chooseCredentials, createDevCognitoClient, devPoolConfig } from './aws.js';
import { checkProductionBuild } from './build-check.js';
import { checkDevRouteAbsent } from './http-check.js';
import { DEV_SIGN_IN_ROUTE } from './marker.js';
import { defaultPersonas, parsePersonas } from './personas.js';
import { seedPersonas } from './seed.js';

export interface CliIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests inject a mocked client and clock. */
  createClient?: (input: { region: string; profile?: string }) => CognitoIdentityProviderClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const CLI_HELP = `auth-kit: the localhost kit

Usage: npx auth-kit <command> [options]

  init-personas      Write a starter personas.json (one persona per role, .test addresses)
                       --domain <name.test>   default personas.test
                       --app-roles <a,b>      add a persona per app role
                       --file <path>          default personas.json
                       --force                overwrite an existing file

  seed-personas      Create or update the personas in your sandbox pool (idempotent)
                       --profile <name>       AWS profile (required, or set AWS_PROFILE)
                       --account <id>         refuse unless the pool is in this AWS account
                       --region <region>      default: from amplify_outputs.json / the pool ID
                       --outputs <path>       default amplify_outputs.json
                       --pool <id> --client <id>   instead of amplify_outputs.json
                       --personas <path>      default personas.json
                       --env-file <path>      default .env.local (must be git-ignored)
                       --app-roles <a,b>      the preset's appRoles, to validate groups
                       --no-totp              don't enroll authenticators
                       --dry-run              report what would change; write nothing

  check-prod-build   Fail if a production build contains dev sign-in (run after next build)
                       --dir <path>           default .next
                       --route <path>         default ${DEV_SIGN_IN_ROUTE}

  check-dev-route    Fail unless a running production build answers the dev route with 404
                       --url <base>           e.g. http://127.0.0.1:3000 (required)
                       --route <path>         default ${DEV_SIGN_IN_ROUTE}

Exit codes: 0 ok, 1 refused or check failed, 2 usage error.`;

class UsageError extends Error {}

function list(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function readJson(path: string, what: string, hint: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`auth-kit: no ${what} at ${path}. ${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`auth-kit: ${path} isn't valid JSON.`);
  }
}

async function initPersonas(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { domain: { type: 'string' }, 'app-roles': { type: 'string' }, file: { type: 'string' }, force: { type: 'boolean' } },
    strict: true,
  });
  const file = resolve(io.cwd, values.file ?? 'personas.json');
  const appRoles = list(values['app-roles']);
  const personas = defaultPersonas({ ...(values.domain !== undefined && { domain: values.domain }), ...(appRoles && { appRoles }) });
  parsePersonas(personas, appRoles ? { appRoles } : {});
  try {
    await writeFile(file, `${JSON.stringify(personas, null, 2)}\n`, { flag: values.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`auth-kit: ${file} exists. Pass --force to overwrite it.`, { cause: error });
    throw error;
  }
  io.out(`Wrote ${personas.length} personas to ${file}. Next: npx auth-kit seed-personas --profile <name>`);
  return 0;
}

async function seed(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      account: { type: 'string' },
      region: { type: 'string' },
      outputs: { type: 'string' },
      pool: { type: 'string' },
      client: { type: 'string' },
      personas: { type: 'string' },
      'env-file': { type: 'string' },
      'app-roles': { type: 'string' },
      'no-totp': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'max-users': { type: 'string' },
    },
    strict: true,
  });
  if (values.account !== undefined && !/^\d{12}$/.test(values.account)) throw new UsageError('--account must be a 12-digit AWS account ID.');
  const maxUsers = values['max-users'] === undefined ? undefined : Number(values['max-users']);
  if (maxUsers !== undefined && (!Number.isInteger(maxUsers) || maxUsers < 1)) throw new UsageError('--max-users must be a positive whole number.');

  const personas = await readJson(resolve(io.cwd, values.personas ?? 'personas.json'), 'personas.json', 'Run `npx auth-kit init-personas` first.');
  const outputs =
    values.pool && values.client
      ? undefined
      : ((await readJson(resolve(io.cwd, values.outputs ?? 'amplify_outputs.json'), 'amplify_outputs.json', 'Run `npx ampx sandbox` first.')) as Parameters<
          typeof devPoolConfig
        >[0]['outputs']);
  const pool = devPoolConfig({
    ...(outputs !== undefined && { outputs }),
    ...(values.pool !== undefined && { userPoolId: values.pool }),
    ...(values.client !== undefined && { clientId: values.client }),
    ...(values.region !== undefined && { region: values.region }),
  });
  const credentials = chooseCredentials(values.profile, io.env);
  io.out(`Using ${credentials.source}, ${pool.region}, pool ${pool.userPoolId}.`);
  const clientInput = { region: pool.region, ...(credentials.profile !== undefined && { profile: credentials.profile }) };
  const client = io.createClient ? io.createClient(clientInput) : createDevCognitoClient(clientInput);
  const appRoles = list(values['app-roles']);
  const expectedAccountId = values.account ?? io.env.AUTH_KIT_AWS_ACCOUNT;

  const report = await seedPersonas({
    client,
    userPoolId: pool.userPoolId,
    clientId: pool.clientId,
    personas,
    cwd: io.cwd,
    ...(values['env-file'] !== undefined && { envFile: values['env-file'] }),
    ...(appRoles && { appRoles }),
    ...(expectedAccountId !== undefined && { expectedAccountId }),
    ...(maxUsers !== undefined && { maxUsers }),
    totp: values['no-totp'] !== true,
    dryRun: values['dry-run'] === true,
    log: io.out,
    ...(io.now !== undefined && { now: io.now }),
    ...(io.sleep !== undefined && { sleep: io.sleep }),
  });
  if (expectedAccountId === undefined) io.out('Tip: pass --account <id> so a wrong profile is refused before anything is written.');
  io.out(
    report.dryRun
      ? 'Dry run: nothing was written.'
      : report.unchanged
        ? 'Every persona was already up to date (each one signed in to prove it).'
        : `Done. Passwords and authenticator secrets are in ${report.envFile} (git-ignored). Set ALLOW_DEV_SIGNIN=1 there to turn on "Sign in as…".`,
  );
  return 0;
}

async function checkBuild(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, route: { type: 'string' } }, strict: true });
  const buildDir = resolve(io.cwd, values.dir ?? '.next');
  const result = await checkProductionBuild({ buildDir, ...(values.route !== undefined && { devRoute: values.route }) });
  if (result.ok) {
    io.out(`OK: no dev sign-in code or route in ${buildDir} (${result.filesScanned} files scanned).`);
    return 0;
  }
  io.err(`FAIL: dev sign-in is in the production build ${buildDir}:`);
  for (const f of result.findings) io.err(`  - ${f.file ? `${f.file}: ` : ''}${f.detail}`);
  return 1;
}

async function checkRoute(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: { url: { type: 'string' }, route: { type: 'string' } }, strict: true });
  if (!values.url) throw new UsageError('check-dev-route needs --url, e.g. --url http://127.0.0.1:3000');
  const result = await checkDevRouteAbsent({ baseUrl: values.url, ...(values.route !== undefined && { route: values.route }) });
  for (const p of result.probes) (p.ok ? io.out : io.err)(`  ${p.ok ? 'ok  ' : 'FAIL'} ${p.method} Host: ${p.host} -> ${p.status ?? 'no answer'}${p.problem ? ` (${p.problem})` : ''}`);
  if (result.ok) io.out(`OK: ${values.route ?? DEV_SIGN_IN_ROUTE} answers 404 to every forged request.`);
  else io.err('FAIL: the dev route did not answer a plain 404 to every request.');
  return result.ok ? 0 : 1;
}

/** Runs one command; returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'init-personas':
        return await initPersonas(args, io);
      case 'seed-personas':
        return await seed(args, io);
      case 'check-prod-build':
        return await checkBuild(args, io);
      case 'check-dev-route':
        return await checkRoute(args, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(CLI_HELP);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${command}".`);
    }
  } catch (error) {
    const usage = error instanceof UsageError || (error instanceof Error && 'code' in error && String((error as { code: unknown }).code).startsWith('ERR_PARSE_ARGS'));
    io.err(error instanceof Error ? error.message : String(error));
    if (usage) io.err('Run `npx auth-kit help` for usage.');
    return usage ? 2 : 1;
  }
}
