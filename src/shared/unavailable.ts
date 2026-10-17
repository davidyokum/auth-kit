/**
 * "Couldn't check" (503, `AuthUnavailableError`) as error boundaries see it. No imports, so the
 * server's error class and the client's boundary helper share it.
 *
 * In a production build, Next replaces a server error with a generic one before it reaches an error
 * boundary: the name and message are gone and only `digest` survives. Next keeps a digest the thrown
 * error already has (`create-error-handler.js`: "If the error already has a digest, respect the
 * original digest"), so `AuthUnavailableError` carries its own: this prefix plus a random reference
 * that ties the boundary's "Reference: …" to the server's log line.
 */
export const AUTH_UNAVAILABLE_DIGEST = 'AUTH_KIT_AUTH_UNAVAILABLE';

/** A digest for one `AuthUnavailableError`: `AUTH_KIT_AUTH_UNAVAILABLE;<16 hex>`. */
export function authUnavailableDigest(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const id = uuid ? uuid.replace(/-/g, '').slice(0, 16) : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
  return `${AUTH_UNAVAILABLE_DIGEST};${id}`;
}

/**
 * True for auth-kit's "couldn't check" error: the `AuthUnavailableError` itself on the server, and
 * the error an error boundary receives for it, in development (by name) and in production builds (by
 * digest). Use it in `error.tsx` / `global-error.tsx` to say honestly that the page stayed closed
 * because the sign-in service didn't answer.
 */
export function isAuthUnavailableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, digest } = error as { name?: unknown; digest?: unknown };
  if (typeof digest === 'string' && (digest === AUTH_UNAVAILABLE_DIGEST || digest.startsWith(`${AUTH_UNAVAILABLE_DIGEST};`))) return true;
  return name === 'AuthUnavailableError';
}
