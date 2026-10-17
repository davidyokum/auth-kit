import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  FetchError,
  JwksValidationError,
  JwtBaseError,
  JwtExpiredError,
  JwtInvalidClaimError,
  NonRetryableFetchError,
} from 'aws-jwt-verify/error';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import type { JwksLike } from './jwks.js';
import { type PoolConfig, resolvePoolConfig } from './config.js';
import { AuthUnavailableError, UnauthenticatedError } from './errors.js';

/**
 * Claim-time policy applied after the signature checks (seconds). Cognito issues `iat` from its own
 * clock, so a small allowance covers drift; anything further in the future, or a token that claims
 * to live longer than Cognito allows, is refused rather than trusted.
 */
export const TOKEN_TIME_POLICY = {
  /** How far in the future `iat` (and `auth_time`) may be. */
  maxClockSkewSeconds: 300,
  /** Cognito's longest access and ID token validity: 1 day. */
  maxTokenLifetimeSeconds: 24 * 60 * 60,
} as const;

/** The claims of a verified Cognito access token. */
export interface AccessTokenClaims {
  sub: string;
  /** The Cognito username (a UUID in pools that sign in with email). Absent on machine tokens. */
  username?: string;
  client_id: string;
  token_use: 'access';
  iss: string;
  /** Seconds since the epoch. */
  exp: number;
  iat: number;
  /** When the person actually signed in. Refreshing doesn't change it. */
  auth_time: number;
  jti: string;
  origin_jti?: string;
  event_id?: string;
  scope?: string;
  'cognito:groups'?: string[];
  [claim: string]: unknown;
}

/** The claims of a verified ID token that auth-kit reads (for display and audit logs only). */
export interface IdTokenClaims {
  sub: string;
  aud: string;
  token_use: 'id';
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  [claim: string]: unknown;
}

export interface TokenVerifier {
  /**
   * Signature, expiry, issuer, audience (`client_id`), and `token_use` = access, then the claim shape
   * (`sub`, `jti`, `exp`, `iat`, `auth_time` present and well-formed; `iat` not in the future; a
   * lifetime Cognito could have issued). Throws AuthError: `token_expired` (401) for a genuine token
   * of this pool and client that has merely expired, `invalid_token` (401) for anything else wrong,
   * `auth_unavailable` (503) when the keys can't be loaded.
   */
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
  /** Same checks for an ID token (`aud`, `token_use` = id). Never use ID tokens to authorize. */
  verifyIdToken(token: string): Promise<IdTokenClaims>;
  /** Fetches the JWKS ahead of the first request (optional). */
  hydrate(): Promise<void>;
}

export interface TokenVerifierOptions extends PoolConfig {
  /**
   * Preloads the pool's JWKS instead of fetching it (tests, or offline builds). In production leave
   * it out: keys are fetched once from the pool's `/.well-known/jwks.json` and cached in memory.
   */
  jwks?: JwksLike;
  /**
   * Replaces the HTTPS fetch of the pool's JWKS (tests, or a custom HTTP stack). Receives the JWKS
   * URI and returns the parsed JSON. Errors it throws count as "couldn't check" (503).
   */
  jwksFetcher?: (uri: string) => Promise<unknown>;
  /** Milliseconds since the epoch, for the claim-time policy (tests). Default `Date.now`. */
  now?: () => number;
}

type TokenKind = 'access' | 'id';

const invalid = (detail: string) =>
  new UnauthenticatedError('invalid_token', 'Your session is invalid or has expired. Sign in again.', {
    cause: new Error(`auth-kit: ${detail}`),
  });

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * `aws-jwt-verify` checks claims only when they're present (a token without `exp` never expires to
 * it). Cognito always issues these, so a token without them is refused instead of producing
 * `NaN` cache lifetimes or an empty cache key shared between people.
 */
function assertClaimShape(payload: Record<string, unknown>, kind: TokenKind, nowMs: number): void {
  if (!isNonEmptyString(payload.sub)) throw invalid('token has no sub');
  for (const claim of ['exp', 'iat'] as const) {
    if (!isFiniteNumber(payload[claim])) throw invalid(`token has no numeric ${claim}`);
  }
  const exp = payload.exp as number;
  const iat = payload.iat as number;
  const latest = nowMs / 1000 + TOKEN_TIME_POLICY.maxClockSkewSeconds;
  if (iat > latest) throw invalid('token was issued in the future');
  if (exp <= iat) throw invalid('token expires before it was issued');
  if (exp - iat > TOKEN_TIME_POLICY.maxTokenLifetimeSeconds) throw invalid('token lifetime is longer than Cognito issues');
  if (kind === 'id') return;
  if (!isNonEmptyString(payload.jti)) throw invalid('access token has no jti');
  if (!isFiniteNumber(payload.auth_time)) throw invalid('access token has no numeric auth_time');
  if (payload.auth_time > iat + TOKEN_TIME_POLICY.maxClockSkewSeconds) throw invalid('auth_time is after iat');
  // Machine tokens (client credentials) have no username; when present it must be a real string.
  if (payload.username !== undefined && !isNonEmptyString(payload.username)) throw invalid('username is not a string');
  if (payload.scope !== undefined && typeof payload.scope !== 'string') throw invalid('scope is not a string');
  const groups = payload['cognito:groups'];
  if (groups !== undefined && !(Array.isArray(groups) && groups.every((g) => typeof g === 'string'))) {
    throw invalid('cognito:groups is not a list of strings');
  }
}

/**
 * Fetch and key-set problems mean "couldn't check" (503), not "bad token" (401).
 *
 * `aws-jwt-verify` resolves the issuer (only this pool's) and checks the signature against this
 * pool's keys before any claim, and checks expiry first among the claims. So an expiry error means
 * the token is genuine; it's reported as `token_expired` only when it was also issued to this app
 * client as the expected token type. That's the one case where a server-side refresh can help.
 */
function toAuthError(error: unknown, kind: TokenKind, clientId: string): Error {
  if (error instanceof FetchError || error instanceof NonRetryableFetchError || error instanceof JwksValidationError) {
    return new AuthUnavailableError("Couldn't load the sign-in keys to check this session.", { cause: error });
  }
  if (error instanceof JwtBaseError) {
    let expiredHere = false;
    if (error instanceof JwtInvalidClaimError) {
      const payload = error.rawJwt?.payload as Record<string, unknown> | undefined;
      expiredHere =
        error instanceof JwtExpiredError &&
        payload?.token_use === kind &&
        (kind === 'access' ? payload.client_id === clientId : payload.aud === clientId);
      // The raw payload was only needed for that decision; keep it out of logged causes.
      delete error.rawJwt;
    }
    return expiredHere
      ? new UnauthenticatedError('token_expired', 'Your session has expired. Sign in again.', { cause: error })
      : new UnauthenticatedError('invalid_token', 'Your session is invalid or has expired. Sign in again.', {
          cause: error,
        });
  }
  return new AuthUnavailableError("Couldn't check this session.", { cause: error });
}

/** Builds a verifier bound to one pool and one app client. Reuse it: the JWKS cache lives inside. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { userPoolId, clientId } = resolvePoolConfig(options);
  const { jwksFetcher } = options;
  // One key cache for both token types.
  const jwksCache = new SimpleJwksCache(
    jwksFetcher
      ? {
          fetcher: {
            fetch: async (uri: string) => {
              let body: unknown;
              try {
                body = await jwksFetcher(uri);
              } catch (error) {
                throw new FetchError(uri, error instanceof Error ? error.message : String(error));
              }
              return new TextEncoder().encode(JSON.stringify(body)).buffer;
            },
          },
        }
      : undefined,
  );
  const now = options.now ?? Date.now;
  // includeRawJwtInErrors lets toAuthError tell "expired, but ours" from "expired, someone else's".
  const access = CognitoJwtVerifier.create(
    { userPoolId, clientId, tokenUse: 'access', includeRawJwtInErrors: true },
    { jwksCache },
  );
  const id = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id', includeRawJwtInErrors: true }, { jwksCache });
  if (options.jwks) {
    access.cacheJwks(options.jwks as Parameters<typeof access.cacheJwks>[0]);
    id.cacheJwks(options.jwks as Parameters<typeof id.cacheJwks>[0]);
  }

  return {
    async verifyAccessToken(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new UnauthenticatedError();
      }
      let payload: Record<string, unknown>;
      try {
        payload = await access.verify(token);
      } catch (error) {
        throw toAuthError(error, 'access', clientId);
      }
      assertClaimShape(payload, 'access', now());
      return payload as AccessTokenClaims;
    },
    async verifyIdToken(token) {
      if (typeof token !== 'string' || token.length === 0) throw new UnauthenticatedError();
      let payload: Record<string, unknown>;
      try {
        payload = await id.verify(token);
      } catch (error) {
        throw toAuthError(error, 'id', clientId);
      }
      assertClaimShape(payload, 'id', now());
      return payload as IdTokenClaims;
    },
    async hydrate() {
      try {
        await access.hydrate();
      } catch (error) {
        throw toAuthError(error, 'access', clientId);
      }
    },
  };
}
