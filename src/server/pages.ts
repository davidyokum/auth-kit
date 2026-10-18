import type { ResourceNeed } from '../resources/policy.js';
import type { AuthUser, RequireRoleOptions, RequireUserOptions, ResourceAccess, ResourceGuardOptions, ServerAuth } from './auth.js';
import { AuthUnavailableError, isAuthError } from './errors.js';
import { safeRedirect } from './redirect.js';

/** The request header `withAuthProxy` sets with the requested path, used to build sign-in return links. */
export const RETURN_PATH_HEADER = 'x-auth-kit-path';

export interface PageGuardOptions {
  /** Default `/sign-in`. */
  signInPath?: string;
  /** Where password users without an authenticator go. Default `/account/authenticator`. */
  mfaSetupPath?: string;
  /**
   * Forbidden pages render Next's not-found page by default (works everywhere, and doesn't confirm
   * the page exists). `forbidden` calls Next's `forbidden()`, which needs `experimental.authInterrupts`.
   */
  onForbidden?: 'not-found' | 'forbidden';
  /** Where to return after sign-in. Default: the path the proxy recorded, else `/`. */
  returnTo?: string;
}

/** Builds `/sign-in?next=<path>` (and `&reauth=1` for step-up), with the return path made safe. */
export function signInUrl(returnTo: string | undefined, options: { signInPath?: string; reauth?: boolean } = {}): string {
  const path = safeRedirect(options.signInPath ?? '/sign-in', '/sign-in');
  const params = new URLSearchParams({ next: safeRedirect(returnTo, '/') });
  if (options.reauth) params.set('reauth', '1');
  return `${path}?${params.toString()}`;
}

async function currentPath(): Promise<string | undefined> {
  try {
    const { headers } = await import('next/headers.js');
    return (await headers()).get(RETURN_PATH_HEADER) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts an auth failure on a page into the right Next.js response: sign-in redirect for 401,
 * the authenticator setup page for missing TOTP, not-found (or forbidden) for 403 and 404. A 503
 * ("couldn't check") is rethrown so the error boundary says so honestly: its digest survives Next's
 * production error redaction, so the boundary can tell with `isAuthUnavailableError(error)`.
 */
export async function handlePageAuthError(error: unknown, options: PageGuardOptions = {}): Promise<never> {
  if (!isAuthError(error) || error instanceof AuthUnavailableError) throw error;
  const nav = await import('next/navigation.js');
  switch (error.code) {
    case 'unauthenticated':
    case 'invalid_token':
    case 'token_expired':
    case 'account_disabled':
    case 'step_up_required': {
      const returnTo = options.returnTo ?? (await currentPath());
      nav.redirect(
        signInUrl(returnTo, {
          ...(options.signInPath !== undefined && { signInPath: options.signInPath }),
          reauth: error.code === 'step_up_required',
        }),
      );
      break;
    }
    case 'mfa_enrollment_required':
      nav.redirect(safeRedirect(options.mfaSetupPath ?? '/account/authenticator', '/account/authenticator'));
      break;
    case 'forbidden':
    case 'origin_mismatch':
      if (options.onForbidden === 'forbidden') nav.forbidden();
      nav.notFound();
      break;
    case 'not_found':
      nav.notFound();
      break;
    case 'auth_unavailable':
      break;
  }
  throw error;
}

/** Page versions of the guards: same checks, but failures become redirects or not-found pages. */
export interface PageGuards<G extends string, C extends string> {
  requireUser(options?: RequireUserOptions & PageGuardOptions): Promise<AuthUser<C>>;
  requireGroup(groups: G | readonly G[], options?: RequireRoleOptions & PageGuardOptions): Promise<AuthUser<C>>;
  requireCan(capability: C, options?: RequireRoleOptions & PageGuardOptions): Promise<AuthUser<C>>;
  /** `requireResourceRole` for a page: no access (403 or 404) renders the not-found page. */
  requireResourceRole(
    type: string,
    id: string,
    need: ResourceNeed,
    options?: ResourceGuardOptions<C> & PageGuardOptions,
  ): Promise<ResourceAccess<C>>;
}

/**
 * ```ts
 * // lib/auth.ts
 * export const pages = createPageGuards(auth);
 * // app/admin/people/page.tsx
 * const user = await pages.requireCan('people.manage', { live: true });
 * ```
 */
export function createPageGuards<G extends string, C extends string>(
  auth: ServerAuth<G, C>,
  defaults: PageGuardOptions = {},
): PageGuards<G, C> {
  const guard = async <T>(run: () => Promise<T>, options: PageGuardOptions): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      return handlePageAuthError(error, { ...defaults, ...options });
    }
  };
  return {
    requireUser: (options = {}) => guard(() => auth.requireUser(options), options),
    requireGroup: (groups, options = {}) => guard(() => auth.requireGroup(groups, options), options),
    requireCan: (capability, options = {}) => guard(() => auth.requireCan(capability, options), options),
    requireResourceRole: (type, id, need, options = {}) => guard(() => auth.requireResourceRole(type, id, need, options), options),
  };
}
