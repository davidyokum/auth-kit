import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwksValidationError, JwtBaseError, NonRetryableFetchError } from 'aws-jwt-verify/error';
import type { JwksLike } from './jwks.js';
import { type PoolConfig, resolvePoolConfig } from './config.js';
import { AuthUnavailableError, UnauthenticatedError } from './errors.js';

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
  /** Signature, expiry, issuer, audience (`client_id`), and `token_use` = access. Throws AuthError. */
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
}

/** Fetch and key-set problems mean "couldn't check" (503), not "bad token" (401). */
function toAuthError(error: unknown): Error {
  if (error instanceof FetchError || error instanceof NonRetryableFetchError || error instanceof JwksValidationError) {
    return new AuthUnavailableError("Couldn't load the sign-in keys to check this session.", { cause: error });
  }
  if (error instanceof JwtBaseError) {
    return new UnauthenticatedError('invalid_token', 'Your session is invalid or has expired. Sign in again.', {
      cause: error,
    });
  }
  return new AuthUnavailableError("Couldn't check this session.", { cause: error });
}

/** Builds a verifier bound to one pool and one app client. Reuse it: the JWKS cache lives inside. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { userPoolId, clientId } = resolvePoolConfig(options);
  const access = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  const id = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  if (options.jwks) {
    access.cacheJwks(options.jwks as Parameters<typeof access.cacheJwks>[0]);
    id.cacheJwks(options.jwks as Parameters<typeof id.cacheJwks>[0]);
  }

  return {
    async verifyAccessToken(token) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new UnauthenticatedError();
      }
      try {
        return (await access.verify(token)) as unknown as AccessTokenClaims;
      } catch (error) {
        throw toAuthError(error);
      }
    },
    async verifyIdToken(token) {
      if (typeof token !== 'string' || token.length === 0) throw new UnauthenticatedError();
      try {
        return (await id.verify(token)) as unknown as IdTokenClaims;
      } catch (error) {
        throw toAuthError(error);
      }
    },
    async hydrate() {
      try {
        await access.hydrate();
      } catch (error) {
        throw toAuthError(error);
      }
    },
  };
}
