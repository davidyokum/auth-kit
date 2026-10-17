/**
 * "Couldn't check" must reach production error boundaries honestly (#10). Next replaces a server
 * error with a generic one in production (only `digest` survives), but keeps a digest the error
 * already has, so `AuthUnavailableError` carries one. These tests run Next's own error handlers.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../src/client/index.js';
import {
  AUTH_UNAVAILABLE_DIGEST,
  AuthUnavailableError,
  ForbiddenError,
  UnauthenticatedError,
  createCognitoGateway,
  handlePageAuthError,
  isAuthUnavailableError,
} from '../../src/server/index.js';

type ErrorHandler = (error: unknown, info?: unknown) => string | undefined;
const nextErrors = createRequire(import.meta.url)('next/dist/server/app-render/create-error-handler.js') as {
  createReactServerErrorHandler: (format: boolean, prerender: boolean, errors: Map<string, Error>, onError: () => void) => ErrorHandler;
  createHTMLErrorHandler: (
    format: boolean,
    prerender: boolean,
    bailout: boolean,
    errors: Map<string, Error>,
    captured: unknown[],
    onError: () => void,
  ) => ErrorHandler;
};

/** What a client error boundary receives in a production build: a generic error plus the digest. */
function redactedForBrowser(digest: string | undefined): Error & { digest?: string } {
  const error = new Error(
    'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.',
  ) as Error & { digest?: string };
  if (digest !== undefined) error.digest = digest;
  return error;
}

afterEach(() => vi.unstubAllEnvs());

describe('AuthUnavailableError digest', () => {
  it('carries AUTH_KIT_AUTH_UNAVAILABLE;<16 hex>, a fresh reference per error', () => {
    const a = new AuthUnavailableError();
    const b = new AuthUnavailableError('Cognito timed out', { cause: new Error('ETIMEDOUT') });
    expect(a.digest).toMatch(/^AUTH_KIT_AUTH_UNAVAILABLE;[0-9a-f]{16}$/);
    expect(b.digest.startsWith(`${AUTH_UNAVAILABLE_DIGEST};`)).toBe(true);
    expect(a.digest).not.toBe(b.digest);
    expect(b.status).toBe(503);
  });

  it('is the digest Next keeps, in its RSC and HTML error handlers, in production and development', () => {
    for (const env of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', env);
      const error = new AuthUnavailableError();
      const rsc = nextErrors.createReactServerErrorHandler(false, false, new Map(), () => undefined);
      expect(rsc(error), env).toBe(error.digest);
      const html = nextErrors.createHTMLErrorHandler(false, false, false, new Map(), [], () => undefined);
      expect(html(new AuthUnavailableError()), env).toMatch(/^AUTH_KIT_AUTH_UNAVAILABLE;/);
      // Any other error gets Next's numeric hash, which says nothing about what failed.
      expect(rsc(new Error('boom')), env).toMatch(/^\d+$/);
    }
  });

  it('reaches the boundary through a page guard: handlePageAuthError rethrows it untouched', async () => {
    const error = new AuthUnavailableError();
    await expect(handlePageAuthError(error)).rejects.toBe(error);
  });

  it('is what the real Cognito gateway throws when Cognito is unreachable', async () => {
    const client = { send: () => Promise.reject(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })) };
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client: client as never });
    const thrown = await gateway.getLiveUserState('u1').catch((e: unknown) => e);
    expect(isAuthUnavailableError(thrown)).toBe(true);
    expect((thrown as AuthUnavailableError).digest).toMatch(/^AUTH_KIT_AUTH_UNAVAILABLE;/);
  });
});

describe('isAuthUnavailableError', () => {
  it('recognizes the server error, the production boundary error (by digest), and the dev boundary error (by name)', () => {
    const error = new AuthUnavailableError();
    expect(isAuthUnavailableError(error)).toBe(true);
    expect(isAuthUnavailableError(redactedForBrowser(error.digest))).toBe(true);
    expect(isAuthUnavailableError(redactedForBrowser(AUTH_UNAVAILABLE_DIGEST))).toBe(true);
    expect(isAuthUnavailableError(Object.assign(new Error('Sign-in status is temporarily unavailable.'), { name: 'AuthUnavailableError' }))).toBe(true);
  });

  it('says no to everything else', () => {
    for (const value of [
      new Error('boom'),
      redactedForBrowser('2914738123'), // Next's hash for an ordinary error
      redactedForBrowser(undefined),
      redactedForBrowser('NEXT_HTTP_ERROR_FALLBACK;404'),
      redactedForBrowser(`x${AUTH_UNAVAILABLE_DIGEST};abc`),
      redactedForBrowser(`${AUTH_UNAVAILABLE_DIGEST}X`),
      new UnauthenticatedError(),
      new ForbiddenError(),
      null,
      undefined,
      'AuthUnavailableError',
      { digest: 42 },
    ]) {
      expect(isAuthUnavailableError(value), JSON.stringify({ value, digest: (value as { digest?: unknown } | null)?.digest })).toBe(false);
    }
  });

  it('is exported from auth-kit/client for error.tsx, the same function as the server’s', () => {
    expect(client.isAuthUnavailableError).toBe(isAuthUnavailableError);
    expect(client.AUTH_UNAVAILABLE_DIGEST).toBe(AUTH_UNAVAILABLE_DIGEST);
  });
});
