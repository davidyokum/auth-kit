import { describe, expect, it } from 'vitest';
import { AuthUnavailableError, createTokenVerifier, UnauthenticatedError } from '../../src/server/index.js';
import { createTestIssuer, tamperToken, unsignedToken } from '../../src/testing/index.js';
import { CLIENT_ID, OTHER_CLIENT_ID, OTHER_POOL_ID, POOL_ID } from '../helpers.js';

const issuer = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
const fetches: string[] = [];
const verifier = createTokenVerifier({
  userPoolId: POOL_ID,
  clientId: CLIENT_ID,
  jwks: issuer.jwks,
  jwksFetcher: (uri) => {
    fetches.push(uri);
    return Promise.resolve(issuer.jwks);
  },
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function expect401(token: string) {
  const error = await rejection(verifier.verifyAccessToken(token));
  expect(error).toBeInstanceOf(UnauthenticatedError);
  expect((error as UnauthenticatedError).status).toBe(401);
  return error as UnauthenticatedError;
}

describe('verifyAccessToken: the five checks', () => {
  it('accepts a valid access token and returns its claims', async () => {
    const token = issuer.mintAccessToken({ sub: 'user-1', groups: ['editor'] });
    const claims = await verifier.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.token_use).toBe('access');
    expect(claims.client_id).toBe(CLIENT_ID);
    expect(claims['cognito:groups']).toEqual(['editor']);
  });

  it('1. signature: rejects a payload edited after signing (forged groups)', async () => {
    const token = tamperToken(issuer.mintAccessToken({ groups: ['viewer'] }), { 'cognito:groups': ['superadmin'] });
    const error = await expect401(token);
    expect(error.code).toBe('invalid_token');
  });

  it('1. signature: rejects an unsigned alg:none token', async () => {
    await expect401(
      unsignedToken({
        sub: 'x',
        iss: issuer.issuer,
        client_id: CLIENT_ID,
        token_use: 'access',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    );
  });

  it('1. signature: rejects a token signed by a different key that claims our kid', async () => {
    const impostor = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID, kid: issuer.kid });
    await expect401(impostor.mintAccessToken());
  });

  it('2. expiry: rejects an expired token', async () => {
    await expect401(issuer.mintAccessToken({ expiresIn: -60 }));
  });

  it('3. issuer: rejects a token naming another pool, even when signed with a trusted key', async () => {
    const other = `https://cognito-idp.us-east-1.amazonaws.com/${OTHER_POOL_ID}`;
    await expect401(issuer.mintAccessToken({ claims: { iss: other } }));
  });

  it('3. issuer: rejects a valid token from another pool (unknown key)', async () => {
    const otherPool = createTestIssuer({ userPoolId: OTHER_POOL_ID, clientId: CLIENT_ID });
    await expect401(otherPool.mintAccessToken());
  });

  it("4. audience: rejects a token issued to another app's client", async () => {
    await expect401(issuer.mintAccessToken({ claims: { client_id: OTHER_CLIENT_ID } }));
  });

  it('5. token use: rejects an ID token presented as an access token', async () => {
    await expect401(issuer.mintIdToken({ email: 'a@example.org' }));
  });

  it('rejects empty and malformed input as 401', async () => {
    await expect401('');
    await expect401('not-a-jwt');
    await expect401('a.b.c');
  });

  it('accepts a valid ID token through verifyIdToken (for display only)', async () => {
    const claims = await verifier.verifyIdToken(issuer.mintIdToken({ sub: 'u', email: 'a@example.org', emailVerified: true }));
    expect(claims.email).toBe('a@example.org');
    expect(claims.token_use).toBe('id');
  });

  it('rejects an access token presented as an ID token', async () => {
    const error = await rejection(verifier.verifyIdToken(issuer.mintAccessToken()));
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });
});

describe('JWKS caching and failures', () => {
  it('verifies from the preloaded key set without fetching', async () => {
    const before = fetches.length;
    await verifier.verifyAccessToken(issuer.mintAccessToken());
    await verifier.verifyAccessToken(issuer.mintAccessToken());
    expect(fetches.length).toBe(before);
  });

  it('refetches the key set once for an unknown kid, then rejects with 401', async () => {
    const fetched: string[] = [];
    const local = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
    const v = createTokenVerifier({
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      jwks: local.jwks,
      jwksFetcher: (uri) => {
        fetched.push(uri);
        return Promise.resolve(local.jwks);
      },
    });
    const stranger = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
    const error = await rejection(v.verifyAccessToken(stranger.mintAccessToken()));
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(fetched).toEqual([`https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}/.well-known/jwks.json`]);
  });

  it('fetches the key set on first use when none is preloaded', async () => {
    const fetched: string[] = [];
    const v = createTokenVerifier({
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      jwksFetcher: (uri) => {
        fetched.push(uri);
        return Promise.resolve(issuer.jwks);
      },
    });
    await v.verifyAccessToken(issuer.mintAccessToken());
    await v.verifyAccessToken(issuer.mintAccessToken());
    expect(fetched).toHaveLength(1);
  });

  it('answers 503 (not 401) when the key set cannot be fetched', async () => {
    const v = createTokenVerifier({
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      jwksFetcher: () => Promise.reject(new Error('network down')),
    });
    const error = await rejection(v.verifyAccessToken(issuer.mintAccessToken()));
    expect(error).toBeInstanceOf(AuthUnavailableError);
    expect((error as AuthUnavailableError).status).toBe(503);
  });

  it('answers 503 when the fetched key set is malformed', async () => {
    const v = createTokenVerifier({
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      jwksFetcher: () => Promise.resolve({ notKeys: true }),
    });
    const error = await rejection(v.verifyAccessToken(issuer.mintAccessToken()));
    expect(error).toBeInstanceOf(AuthUnavailableError);
  });
});

describe('pool configuration', () => {
  it('rejects a malformed pool ID or client ID', () => {
    expect(() => createTokenVerifier({ userPoolId: 'not-a-pool', clientId: CLIENT_ID })).toThrow(/user pool ID/);
    expect(() => createTokenVerifier({ userPoolId: POOL_ID, clientId: '' })).toThrow(/clientId/);
  });
});
