/**
 * `npx auth-kit <command>`: the localhost kit's command line.
 *
 *   init-personas      write a starter personas.json
 *   seed-personas      create or update the personas in your sandbox pool
 *   check-prod-build   fail if a production build contains dev sign-in, the matrix server mode, or the backdrop picker
 *   check-dev-route    fail unless a running production build answers the dev route with 404
 *   owner              make the site's one owner and email them the first-visit invite (src/ops/owner.ts)
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
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createSesInviteMailer, type InviteMailer } from '../admin/mailer.js';
import { createOwner } from '../ops/owner.js';
import { authTheme, isThemeFamily, siteSender } from '../themes/index.js';

export interface CliIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests inject a mocked client and clock. */
  createClient?: (input: { region: string; profile?: string }) => CognitoIdentityProviderClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests inject a mailer instead of SES. */
  createMailer?: (input: { from: string; siteName: string; family: string; help: string; region: string; profile?: string }) => InviteMailer;
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

  check-prod-build   Fail if a production build contains dev sign-in, the matrix server mode, or the
                     backdrop picker (run after next build)
                       --dir <path>           default .next
                       --route <path>         default ${DEV_SIGN_IN_ROUTE}

  check-dev-route    Fail unless a running production build answers the dev route with 404
                       --url <base>           e.g. http://127.0.0.1:3000 (required)
                       --route <path>         default ${DEV_SIGN_IN_ROUTE}

  owner              Make the site's one owner (no password) and email them the invite, whose link
                     opens the sign-in card in first-visit mode with their address filled in
                       --email <address>      the owner (required)
                       --site-name <name>     as site.config.ts names it (required)
                       --sign-in-url <url>    https://<the site's final address>/sign-in (required)
                       --family <family>      personal, osbm, or unc (required)
                       --help-address <addr>  the help address in effect (required)
                       --from <sender>        default: the family's display name and sign-in@ the
                                              sign-in URL's domain
                       --profile <name> --account <12 digits>   (both required)
                       --outputs <path> | --pool <id>           default amplify_outputs.json
                       --name <name>          the owner's display name
                       --dry-run              say what would happen; write and send nothing

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
    io.out(`OK: no dev sign-in, matrix server, or backdrop picker code, and no dev route, in ${buildDir} (${result.filesScanned} files scanned).`);
    return 0;
  }
  io.err(`FAIL: dev-only code is in the production build ${buildDir}:`);
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

async function owner(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'site-name': { type: 'string' },
      'sign-in-url': { type: 'string' },
      family: { type: 'string' },
      'help-address': { type: 'string' },
      from: { type: 'string' },
      profile: { type: 'string' },
      account: { type: 'string' },
      outputs: { type: 'string' },
      pool: { type: 'string' },
      region: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  for (const flag of ['email', 'site-name', 'sign-in-url', 'family', 'help-address', 'account'] as const) {
    if (!values[flag]) throw new UsageError(`owner needs --${flag}.`);
  }
  const family = values.family!;
  if (!isThemeFamily(family)) throw new UsageError('--family must be personal, osbm, or unc.');
  const outputs =
    values.pool !== undefined
      ? undefined
      : ((await readJson(resolve(io.cwd, values.outputs ?? 'amplify_outputs.json'), 'amplify_outputs.json', 'Generate the branch’s outputs first (npx ampx generate outputs --app-id <id> --branch <branch>).')) as Parameters<
          typeof devPoolConfig
        >[0]['outputs']);
  const userPoolId = values.pool ?? outputs?.auth?.user_pool_id;
  if (!userPoolId) throw new UsageError('owner needs the pool: --pool <id>, or an amplify_outputs.json with one.');
  const region = values.region ?? outputs?.auth?.aws_region ?? userPoolId.split('_')[0]!;
  const credentials = chooseCredentials(values.profile, io.env);
  const siteName = values['site-name']!;
  const signInHost = (() => {
    try {
      return new URL(values['sign-in-url']!).hostname;
    } catch {
      throw new UsageError('--sign-in-url must be an absolute address, such as https://reports.example.org/sign-in.');
    }
  })();
  const from = values.from ?? siteSender(siteName, family, authTheme(family).senderAddress ?? `sign-in@${signInHost}`);
  io.out(`Using ${credentials.source}, ${region}, pool ${userPoolId}; the invite comes from ${from}.`);
  const clientInput = { region, ...(credentials.profile !== undefined && { profile: credentials.profile }) };
  const client = io.createClient ? io.createClient(clientInput) : createDevCognitoClient(clientInput);
  const mailerInput = { from, siteName, family, help: values['help-address']!, ...clientInput };
  const mailer = io.createMailer
    ? io.createMailer(mailerInput)
    : createSesInviteMailer({
        from,
        site: { siteName, theme: family, help: mailerInput.help },
        client: new SESv2Client(clientInput),
      });
  const report = await createOwner({
    client,
    mailer,
    userPoolId,
    expectedAccountId: values.account!,
    email: values.email!,
    ...(values.name !== undefined && { name: values.name }),
    siteName,
    signInUrl: values['sign-in-url']!,
    family,
    helpEmail: mailerInput.help,
    dryRun: values['dry-run'] === true,
    log: io.out,
  });
  io.out(
    report.outcome === 'planned'
      ? 'Dry run: nothing was written or sent.'
      : `${report.outcome === 'created' ? 'Made' : 'Re-invited'} ${report.email} as the owner. The invite is in their inbox: its link fills in the address, Email me a code sends the code, and then they set up a passkey.`,
  );
  return 0;
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
      case 'owner':
        return await owner(args, io);
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
