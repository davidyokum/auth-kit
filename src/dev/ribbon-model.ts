/**
 * What the environment ribbon says (primer Chapter 8, Figure 8.3). Pure functions with no imports,
 * safe in production builds, server components, and client components alike.
 *
 * Every environment except the live site shows a ribbon naming the environment, the pool, and the
 * signed-in persona, with a `[DEV]` or `[PREVIEW]` tab title and its own favicon. A local app pointed
 * at a pool that isn't a sandbox (or one nobody could check) turns it red.
 */

export type RibbonEnvironment = 'local' | 'preview' | 'production';

export interface EnvironmentRibbonInput {
  environment: RibbonEnvironment;
  poolId: string;
  /**
   * `true` when the pool is tagged `Environment=sandbox`, `false` when it isn't, and `null` when
   * nobody could check (no AWS credentials, a network error). Only matters locally.
   */
  poolIsSandbox: boolean | null;
  /** Why the check couldn't run, shown when `poolIsSandbox` is `null`. */
  poolCheckError?: string | null;
  /** The signed-in persona's label ("Admin Content"); shown as "Admin Content (test)". */
  persona?: string | null;
  /** Someone signed in who isn't a persona (shown as given, without "(test)"). */
  signedInAs?: string | null;
  /** The preview's branch name. */
  branch?: string | null;
}

export type RibbonTone = 'local' | 'preview' | 'danger' | 'none';

export interface EnvironmentRibbonModel {
  show: boolean;
  tone: RibbonTone;
  /** The bold first part: "LOCAL", "PREVIEW", "LOCAL · NOT A SANDBOX POOL". */
  heading: string;
  /** The rest, in order. */
  details: string[];
  /** Heading and details joined with " · ". */
  label: string;
  titlePrefix: '' | '[DEV] ' | '[PREVIEW] ';
}

function model(tone: RibbonTone, heading: string, details: (string | null | undefined | false)[], titlePrefix: EnvironmentRibbonModel['titlePrefix']): EnvironmentRibbonModel {
  const kept = details.filter((d): d is string => typeof d === 'string' && d.length > 0);
  return { show: true, tone, heading, details: kept, label: [heading, ...kept].join(' · '), titlePrefix };
}

/** What the ribbon shows. The live site shows nothing. */
export function environmentRibbonModel(input: EnvironmentRibbonInput): EnvironmentRibbonModel {
  if (input.environment === 'production') return { show: false, tone: 'none', heading: '', details: [], label: '', titlePrefix: '' };
  const who = input.persona ? `signed in as ${input.persona} (test)` : input.signedInAs ? `signed in as ${input.signedInAs}` : null;
  if (input.environment === 'preview') {
    return model('preview', 'PREVIEW', [input.branch && `branch ${input.branch}`, `pool ${input.poolId}`, 'production build', who], '[PREVIEW] ');
  }
  if (input.poolIsSandbox === true) return model('local', 'LOCAL', [`sandbox pool ${input.poolId}`, who ?? 'signed out'], '[DEV] ');
  if (input.poolIsSandbox === false) {
    return model('danger', 'LOCAL · NOT A SANDBOX POOL', [input.poolId, "may hold real people's accounts", 'dev sign-in off', who], '[DEV] ');
  }
  return model(
    'danger',
    'LOCAL · POOL NOT CHECKED',
    [input.poolId, `couldn't confirm it's a sandbox${input.poolCheckError ? ` (${input.poolCheckError})` : ''}`, 'dev sign-in off', who],
    '[DEV] ',
  );
}

export interface ResolveEnvironmentInput {
  /** Default `process.env.NODE_ENV`. */
  nodeEnv?: string;
  /** Default `process.env.AUTH_KIT_BRANCH ?? process.env.AWS_BRANCH` (Amplify sets `AWS_BRANCH` in builds). */
  branch?: string | null;
  /** Branches that are the live site. Default `['main']`. */
  liveBranches?: readonly string[];
}

function env(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env[name];
}

/**
 * Local under `next dev`; otherwise preview unless the branch is a live one. An unknown branch
 * counts as live (no ribbon): Amplify passes build variables to the server only if the build
 * writes them out, e.g. `echo "AWS_BRANCH=$AWS_BRANCH" >> .env.production` in `amplify.yml`.
 */
export function resolveEnvironment(input: ResolveEnvironmentInput = {}): RibbonEnvironment {
  const nodeEnv = 'nodeEnv' in input ? input.nodeEnv : env('NODE_ENV');
  if (nodeEnv === 'development') return 'local';
  const branch = 'branch' in input ? input.branch : (env('AUTH_KIT_BRANCH') ?? env('AWS_BRANCH'));
  if (!branch) return 'production';
  return (input.liveBranches ?? ['main']).includes(branch) ? 'production' : 'preview';
}

// ---- Tab title and favicon ----------------------------------------------------------------------

/** Ribbon colors. White text passes WCAG AA on each. */
export const RIBBON_COLORS = {
  local: '#1d4ed8',
  preview: '#b45309',
  danger: '#b91c1c',
  viewAs: '#6d28d9',
} as const;

const FAVICON_LETTER: Record<keyof typeof RIBBON_COLORS, string> = { local: 'L', preview: 'P', danger: '!', viewAs: 'V' };

/** A favicon for one mode: a colored square with a letter, as an SVG data URL. */
export function environmentFavicon(tone: keyof typeof RIBBON_COLORS): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${RIBBON_COLORS[tone]}"/>` +
    `<text x="16" y="23" font-family="system-ui,sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#fff">${FAVICON_LETTER[tone]}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface TitleMetadata {
  title: { template: string; default: string };
  icons?: { icon: { url: string; type: string }[] };
}

function withPrefix(prefix: string, base: string | { template?: string; default?: string } | undefined) {
  const template = typeof base === 'object' ? (base.template ?? '%s') : '%s';
  const fallback = typeof base === 'string' ? base : (base?.default ?? '');
  return { template: `${prefix}${template}`, default: `${prefix}${fallback}`.trimEnd() };
}

/**
 * The tab title prefix and favicon for Next's metadata API. Spread it into the root layout's
 * `metadata` (or return it from `generateMetadata`); the live site gets its own title back untouched.
 *
 * ```ts
 * export const metadata = { ...environmentMetadata(environmentRibbonModel(input), { template: '%s · Orchard', default: 'Orchard' }) };
 * ```
 */
export function environmentMetadata(
  ribbon: Pick<EnvironmentRibbonModel, 'tone' | 'titlePrefix'>,
  base?: string | { template?: string; default?: string },
): TitleMetadata {
  if (ribbon.tone === 'none' || ribbon.titlePrefix === '') return { title: withPrefix('', base) };
  return { title: withPrefix(ribbon.titlePrefix, base), icons: { icon: [{ url: environmentFavicon(ribbon.tone), type: 'image/svg+xml' }] } };
}

/** The tab title and favicon while an admin uses View as: "Viewing as Admin Content · Reports". */
export function viewAsMetadata(viewingAs: string, base?: string | { template?: string; default?: string }): TitleMetadata {
  return { title: withPrefix(`Viewing as ${viewingAs} · `, base), icons: { icon: [{ url: environmentFavicon('viewAs'), type: 'image/svg+xml' }] } };
}
