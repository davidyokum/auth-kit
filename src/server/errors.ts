/**
 * Status conventions, used the same way in every app:
 *
 * | Status | Meaning | Error |
 * |---|---|---|
 * | 401 | We don't know who you are (no token, a bad or expired token, a revoked session) | `UnauthenticatedError` (`token_expired` when a genuine token has merely expired) |
 * | 401 | We know you, but this action needs a fresh sign-in (step-up) | `StepUpRequiredError` |
 * | 403 | We know you, and the answer is no (missing capability or group) | `ForbiddenError` |
 * | 403 | You must set up an authenticator code before going further | `MfaEnrollmentRequiredError` |
 * | 404 | The record isn't yours, or doesn't exist; we don't say which | `NotFoundError` |
 * | 503 | We couldn't check (Cognito or its keys unreachable). Never treated as signed out or allowed | `AuthUnavailableError` |
 *
 * Pages turn 401 into a redirect to sign-in. APIs answer with the status and a JSON body.
 */
import { authUnavailableDigest } from '../shared/unavailable.js';

export { AUTH_UNAVAILABLE_DIGEST, isAuthUnavailableError } from '../shared/unavailable.js';
export type AuthErrorCode =
  | 'unauthenticated'
  | 'invalid_token'
  | 'token_expired'
  | 'account_disabled'
  | 'step_up_required'
  | 'forbidden'
  | 'mfa_enrollment_required'
  | 'not_found'
  | 'origin_mismatch'
  | 'auth_unavailable';

export type AuthErrorStatus = 401 | 403 | 404 | 503;

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: AuthErrorStatus;

  constructor(code: AuthErrorCode, status: AuthErrorStatus, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 401: no valid session. `token_expired` means the token was genuine (signed by this pool, issued to
 * this app client, an access token) but past its expiry, so a refresh may help; `invalid_token`
 * means it was forged, foreign, malformed, or revoked.
 */
export class UnauthenticatedError extends AuthError {
  constructor(
    code: Extract<AuthErrorCode, 'unauthenticated' | 'invalid_token' | 'token_expired' | 'account_disabled'> = 'unauthenticated',
    message = 'Sign in to continue.',
    options?: { cause?: unknown },
  ) {
    super(code, 401, message, options);
    this.name = 'UnauthenticatedError';
  }
}

/** 401: a risky action needs a sign-in no older than `maxAgeSeconds`. */
export class StepUpRequiredError extends AuthError {
  readonly maxAgeSeconds: number;
  constructor(maxAgeSeconds: number, message = 'Please sign in again to confirm this action.') {
    super('step_up_required', 401, message);
    this.name = 'StepUpRequiredError';
    this.maxAgeSeconds = maxAgeSeconds;
  }
}

/** 403: signed in, but not allowed. */
export class ForbiddenError extends AuthError {
  constructor(message = "You don't have permission to do that.", code: Extract<AuthErrorCode, 'forbidden' | 'origin_mismatch'> = 'forbidden') {
    super(code, 403, message);
    this.name = 'ForbiddenError';
  }
}

/** 403: a password user hasn't set up an authenticator code yet; send them to the setup screen. */
export class MfaEnrollmentRequiredError extends AuthError {
  constructor(message = 'Set up an authenticator code to continue.') {
    super('mfa_enrollment_required', 403, message);
    this.name = 'MfaEnrollmentRequiredError';
  }
}

/** 404: the record isn't visible to this person. Use it instead of 403 so a route doesn't confirm a record exists. */
export class NotFoundError extends AuthError {
  constructor(message = 'Not found.') {
    super('not_found', 404, message);
    this.name = 'NotFoundError';
  }
}

/**
 * 503: the check couldn't run. Surfaces the reason instead of pretending the person is signed out or
 * allowed. Pages rethrow it to the error boundary; its `digest` (`AUTH_KIT_AUTH_UNAVAILABLE;<id>`)
 * survives Next's production error redaction, so `isAuthUnavailableError(error)` works there too.
 */
export class AuthUnavailableError extends AuthError {
  /** Kept by Next as the boundary's `error.digest`. A random reference per error, for the logs. */
  readonly digest: string;
  constructor(message = 'Sign-in status is temporarily unavailable. Please try again.', options?: { cause?: unknown }) {
    super('auth_unavailable', 503, message, options);
    this.name = 'AuthUnavailableError';
    this.digest = authUnavailableDigest();
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

/** Headers every auth response carries: never cache, and identify the failure for clients. */
function baseHeaders(error: AuthError): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  if (error.status === 401) {
    if (error instanceof StepUpRequiredError) {
      // RFC 9470 (OAuth 2.0 Step Up Authentication Challenge).
      headers.set(
        'WWW-Authenticate',
        `Bearer error="insufficient_user_authentication", error_description="A more recent sign-in is required", max_age=${error.maxAgeSeconds}`,
      );
    } else if (error.code === 'unauthenticated') {
      headers.set('WWW-Authenticate', 'Bearer');
    } else if (error.code === 'token_expired') {
      // RFC 6750 §3.1: an expired token is an invalid_token.
      headers.set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="The access token expired"');
    } else {
      headers.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    }
  }
  if (error.status === 503) headers.set('Retry-After', '5');
  return headers;
}

/** Turns an AuthError into a JSON Response for a route handler. */
export function authErrorResponse(error: AuthError): Response {
  const body: Record<string, unknown> = { error: error.code, message: error.message };
  if (error instanceof StepUpRequiredError) body.maxAgeSeconds = error.maxAgeSeconds;
  return new Response(JSON.stringify(body), { status: error.status, headers: baseHeaders(error) });
}

/**
 * Wraps a route handler so AuthErrors become the right JSON response. Anything else is rethrown.
 *
 * ```ts
 * export const GET = withAuthErrors(async () => {
 *   const user = await auth.requireCan('content.read');
 *   ...
 * });
 * ```
 */
export function withAuthErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response> | Response,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isAuthError(error)) return authErrorResponse(error);
      throw error;
    }
  };
}
