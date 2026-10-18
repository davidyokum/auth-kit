import { type KeyObject, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { JwksLike } from '../server/jwks.js';

/**
 * A stand-in Cognito issuer for tests: its own RSA key, a JWKS to preload into the verifier, and
 * tokens shaped like Cognito's. Nothing touches AWS.
 *
 * ```ts
 * const issuer = createTestIssuer({ userPoolId: 'us-east-1_TestPool1', clientId: 'testclient' });
 * const auth = createServerAuth({ userPoolId, clientId, capabilities, jwks: issuer.jwks, cognito: fakeCognito });
 * const token = issuer.mintAccessToken({ groups: ['admin-content'] });
 * ```
 */
export interface TestIssuerOptions {
  userPoolId: string;
  clientId: string;
  /** Key ID published in the JWKS. Default random. */
  kid?: string;
  /** Seconds since the epoch used as "now" when minting. Default: the real clock. */
  now?: () => number;
}

export interface MintOptions {
  sub?: string;
  username?: string;
  groups?: readonly string[];
  /** Seconds until expiry (negative for an already-expired token). Default 3600. */
  expiresIn?: number;
  /** Seconds since the epoch. Default: now. */
  issuedAt?: number;
  /** Seconds since the epoch. Default: issuedAt. */
  authTime?: number;
  /** Extra or overriding claims (e.g. `{ iss: 'https://evil' }` or `{ client_id: 'other' }`). */
  claims?: Record<string, unknown>;
}

export interface TestIssuer {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly kid: string;
  readonly jwks: JwksLike;
  mintAccessToken(options?: MintOptions): string;
  mintIdToken(options?: MintOptions & { email?: string; emailVerified?: boolean; name?: string }): string;
  /** Signs any header and payload with this issuer's key. */
  sign(header: Record<string, unknown>, payload: Record<string, unknown>): string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signWith(privateKey: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

export function createTestIssuer(options: TestIssuerOptions): TestIssuer {
  const region = options.userPoolId.split('_')[0] ?? 'us-east-1';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${options.userPoolId}`;
  const kid = options.kid ?? randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const jwks: JwksLike = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
  const nowSeconds = () => (options.now ? options.now() : Math.floor(Date.now() / 1000));
  const header = { kid, alg: 'RS256' };

  function base(o: MintOptions) {
    const iat = o.issuedAt ?? nowSeconds();
    const sub = o.sub ?? randomUUID();
    return {
      sub,
      iat,
      exp: iat + (o.expiresIn ?? 3600),
      auth_time: o.authTime ?? iat,
      iss: issuer,
      ...(o.groups !== undefined && { 'cognito:groups': [...o.groups] }),
    };
  }

  return {
    userPoolId: options.userPoolId,
    clientId: options.clientId,
    issuer,
    kid,
    jwks,
    mintAccessToken(o = {}) {
      const b = base(o);
      return signWith(privateKey, header, {
        ...b,
        token_use: 'access',
        client_id: options.clientId,
        username: o.username ?? b.sub,
        scope: 'aws.cognito.signin.user.admin',
        jti: randomUUID(),
        origin_jti: randomUUID(),
        event_id: randomUUID(),
        version: 2,
        ...o.claims,
      });
    },
    mintIdToken(o = {}) {
      const b = base(o);
      return signWith(privateKey, header, {
        ...b,
        token_use: 'id',
        aud: options.clientId,
        'cognito:username': o.username ?? b.sub,
        ...(o.email !== undefined && { email: o.email }),
        ...(o.emailVerified !== undefined && { email_verified: o.emailVerified }),
        ...(o.name !== undefined && { name: o.name }),
        origin_jti: randomUUID(),
        event_id: randomUUID(),
        jti: randomUUID(),
        ...o.claims,
      });
    },
    sign: (h, p) => signWith(privateKey, h, p),
  };
}

/** Changes a token's payload but keeps its original signature (what a forged cookie looks like). */
export function tamperToken(token: string, changes: Record<string, unknown>): string {
  const [head, body, sig] = token.split('.');
  if (!head || !body || sig === undefined) throw new Error('auth-kit: not a JWT');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  return `${head}.${base64url(JSON.stringify({ ...payload, ...changes }))}.${sig}`;
}

/** An unsigned `alg: none` token with the given payload. */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}.`;
}
