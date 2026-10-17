import { describe, expect, it } from 'vitest';
import {
  AuthUnavailableError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
} from '../../src/server/index.js';
import { amplifyCookiePersona, tamperToken } from '../../src/testing/index.js';
import { CLIENT_ID, bearer, harness } from '../helpers.js';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function cookieRequest(input: Parameters<typeof amplifyCookiePersona>[0]): Request {
  const persona = amplifyCookiePersona(input);
  return new Request('https://app.example.org/', { headers: persona.headers as Record<string, string> });
}

describe('getUser', () => {
  it('returns null with no token', async () => {
    const { auth } = harness();
    expect(await auth.getUser({ request: new Request('https://app.example.org/') })).toBeNull();
  });

  it('reads a bearer token', async () => {
    const { auth, issuer } = harness();
    const user = await auth.getUser({ request: bearer(issuer.mintAccessToken({ sub: 's1', groups: ['editor'] })) });
    expect(user?.sub).toBe('s1');
    expect(user?.username).toBe('s1');
    expect(user?.groups).toEqual(['editor']);
    expect([...(user?.capabilities ?? [])].sort()).toEqual(['content.edit', 'content.publish', 'content.read']);
    expect(user?.live).toBe(false);
  });

  it("reads Amplify's ssr cookies, with the profile from a matching ID token", async () => {
    const { auth, issuer } = harness();
    const user = await auth.getUser({
      request: cookieRequest({
        clientId: CLIENT_ID,
        username: 'u-123',
        accessToken: issuer.mintAccessToken({ sub: 'u-123' }),
        idToken: issuer.mintIdToken({ sub: 'u-123', email: 'a@example.org', emailVerified: true, name: 'Alice' }),
      }),
    });
    expect(user?.sub).toBe('u-123');
    expect(user?.profile).toEqual({ email: 'a@example.org', emailVerified: true, name: 'Alice' });
  });

  it("ignores an ID token whose sub doesn't match the access token", async () => {
    const { auth, issuer } = harness();
    const user = await auth.getUser({
      request: cookieRequest({
        clientId: CLIENT_ID,
        username: 'u-1',
        accessToken: issuer.mintAccessToken({ sub: 'u-1' }),
        idToken: issuer.mintIdToken({ sub: 'someone-else', email: 'b@example.org' }),
      }),
    });
    expect(user?.profile).toBeNull();
  });

  it('returns null for forged, expired, or foreign tokens', async () => {
    const { auth, issuer } = harness();
    for (const token of [
      tamperToken(issuer.mintAccessToken({ groups: [] }), { 'cognito:groups': ['superadmin'] }),
      issuer.mintAccessToken({ expiresIn: -1 }),
      issuer.mintAccessToken({ claims: { client_id: 'some-other-client' } }),
      issuer.mintIdToken(),
    ]) {
      expect(await auth.getUser({ request: bearer(token) })).toBeNull();
    }
  });

  it('treats machine tokens (no username) as not a person', async () => {
    const { auth, issuer } = harness();
    expect(await auth.getUser({ request: bearer(issuer.mintAccessToken({ claims: { username: undefined } })) })).toBeNull();
  });

  it("doesn't expose the raw token on the user object", async () => {
    const { auth, issuer } = harness();
    const token = issuer.mintAccessToken();
    const user = await auth.getUser({ request: bearer(token) });
    expect(JSON.stringify(user)).not.toContain(token);
  });

  it('uses the configured context when no request is passed', async () => {
    const { issuer } = harness();
    const token = issuer.mintAccessToken({ sub: 'ctx' });
    const { auth } = harness({
      jwks: issuer.jwks,
      context: () =>
        Promise.resolve({
          cookies: { get: () => undefined },
          headers: new Headers({ authorization: `Bearer ${token}` }),
        }),
    });
    expect((await auth.getUser())?.sub).toBe('ctx');
  });
});

describe('requireUser and the authenticator rule', () => {
  it('throws 401 with no session', async () => {
    const { auth } = harness();
    const error = await rejection(auth.requireUser({ request: new Request('https://app.example.org/') }));
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });

  it('lets a password user with TOTP through', async () => {
    const { auth, issuer } = harness();
    const user = await auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'p' })) });
    expect(user.sub).toBe('p');
  });

  it('refuses a password user with no authenticator (403 mfa_enrollment_required)', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('pw-only', { configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] });
    const error = await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only' })) }));
    expect(error).toBeInstanceOf(MfaEnrollmentRequiredError);
    expect((error as MfaEnrollmentRequiredError).status).toBe(403);
  });

  it('lets that person reach the setup page with allowMfaEnrollment', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    const user = await auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only' })), allowMfaEnrollment: true });
    expect(user.sub).toBe('pw-only');
  });

  it('lets passkey-only and emailed-code-only (new invitee) people through', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('passkey', { configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] });
    cognito.setFactors('invitee', { configured: ['EMAIL_OTP'], mfa: [] });
    await expect(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'passkey' })) })).resolves.toBeTruthy();
    await expect(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'invitee' })) })).resolves.toBeTruthy();
  });

  it('can be switched off', async () => {
    const { auth, issuer, cognito } = harness({ requireTotpForPasswordUsers: false });
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    await expect(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only' })) })).resolves.toBeTruthy();
    expect(cognito.calls).toHaveLength(0);
  });

  it('caches a passing check per token and re-checks a failing one after 30 seconds', async () => {
    const { auth, issuer, cognito, clock } = harness();
    const token = issuer.mintAccessToken({ sub: 'c' });
    await auth.requireUser({ request: bearer(token) });
    await auth.requireUser({ request: bearer(token) });
    expect(cognito.calls.filter((c) => c.method === 'getUserAuthFactors')).toHaveLength(1);

    cognito.setFactors('n', { configured: ['PASSWORD'], mfa: [] });
    const pending = issuer.mintAccessToken({ sub: 'n' });
    await rejection(auth.requireUser({ request: bearer(pending) }));
    cognito.setFactors('n', { configured: ['PASSWORD', 'SOFTWARE_TOKEN'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await rejection(auth.requireUser({ request: bearer(pending) })); // still cached
    clock.now += 31_000;
    await expect(auth.requireUser({ request: bearer(pending) })).resolves.toBeTruthy();
  });

  it('a fresh token (new jti) bypasses the cache, as after enrollment plus a forced refresh', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('e', { configured: ['PASSWORD'], mfa: [] });
    await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'e' })) }));
    cognito.setFactors('e', { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await expect(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'e' })) })).resolves.toBeTruthy();
  });

  it('answers 503, not 401 or a pass, when Cognito cannot be reached', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('down', new AuthUnavailableError());
    const error = await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'down' })) }));
    expect(error).toBeInstanceOf(AuthUnavailableError);
  });

  it('answers 401 when Cognito says the session was revoked', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('revoked', new UnauthenticatedError('invalid_token'));
    const error = await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'revoked' })) }));
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });
});

describe('getUser and the authenticator rule (L6)', () => {
  it('returns null for a password user without an authenticator, so `if (!user)` gates stay safe', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    const req = bearer(issuer.mintAccessToken({ sub: 'pw-only' }));
    expect(await auth.getUser({ request: req })).toBeNull();
  });

  it('returns that person with allowMfaEnrollment (the setup page, a header showing who is signed in)', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    const user = await auth.getUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only' })), allowMfaEnrollment: true });
    expect(user?.sub).toBe('pw-only');
  });

  it('returns enrolled, passkey, and invitee users, sharing the cached factor answer with requireUser', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('pk', { configured: ['WEB_AUTHN'], mfa: [] });
    const token = issuer.mintAccessToken({ sub: 'pk' });
    expect((await auth.getUser({ request: bearer(token) }))?.sub).toBe('pk');
    await auth.requireUser({ request: bearer(token) });
    expect(cognito.calls.filter((c) => c.method === 'getUserAuthFactors')).toHaveLength(1);
  });

  it('returns null when Cognito says the session was revoked, and 503 when it cannot be reached', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('revoked', new UnauthenticatedError('invalid_token'));
    expect(await auth.getUser({ request: bearer(issuer.mintAccessToken({ sub: 'revoked' })) })).toBeNull();
    cognito.setFactors('down', new AuthUnavailableError());
    expect(await rejection(auth.getUser({ request: bearer(issuer.mintAccessToken({ sub: 'down' })) }))).toBeInstanceOf(AuthUnavailableError);
  });

  it('skips the Cognito call when the rule is switched off', async () => {
    const { auth, issuer, cognito } = harness({ requireTotpForPasswordUsers: false });
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    expect(await auth.getUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only' })) })).not.toBeNull();
    expect(cognito.calls).toHaveLength(0);
  });
});

describe('claim shape and the authenticator cache (L1)', () => {
  it.each([
    ['jti', { jti: undefined }],
    ['sub', { sub: undefined }],
    ['exp', { exp: undefined }],
    ['iat', { iat: undefined }],
    ['a string exp', { exp: '9999999999' }],
    ['an empty username', { username: '' }],
    ['non-string groups', { 'cognito:groups': 'superadmin' }],
  ])('refuses a pool-signed token with missing or malformed %s', async (_label, claims) => {
    const { auth, issuer } = harness();
    const req = bearer(issuer.mintAccessToken({ claims }));
    expect(await auth.getUser({ request: req })).toBeNull();
    const error = await rejection(auth.requireUser({ request: req }));
    expect((error as UnauthenticatedError).code).toBe('invalid_token');
  });

  it('never lets two people share a cached factor answer, even with the same token ID', async () => {
    // The reverse of the review's probe: an enrolled person's answer must not admit a password-only one.
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('enrolled', { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    cognito.setFactors('pw-only', { configured: ['PASSWORD'], mfa: [] });
    await auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'enrolled', claims: { jti: 'same-jti' } })) });
    const error = await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub: 'pw-only', claims: { jti: 'same-jti' } })) }));
    expect(error).toBeInstanceOf(MfaEnrollmentRequiredError);
    expect(cognito.calls.filter((c) => c.method === 'getUserAuthFactors')).toHaveLength(2);
  });
});

describe('createServerAuth fails loudly on bad options', () => {
  it.each([
    [{ factorCheckTtlSeconds: Number.NaN }, /factorCheckTtlSeconds/],
    [{ liveCheckTtlSeconds: -1 }, /liveCheckTtlSeconds/],
    [{ stepUpMaxAgeSeconds: Infinity }, /stepUpMaxAgeSeconds/],
    [{ factorLookup: 'token' }, /factorLookup/],
    [{ requireTotpForPasswordUsers: 'yes' }, /requireTotpForPasswordUsers/],
    [{ capabilities: {} }, /defineCapabilities/],
    [{ factorLookUp: 'iam' }, /unknown option "factorLookUp"/],
  ])('%j', (overrides, message) => {
    expect(() => harness(overrides as never)).toThrow(message);
  });
});

describe('requireCan and requireGroup', () => {
  it('allows a capability the groups grant and refuses one they do not (403)', async () => {
    const { auth, issuer } = harness();
    const editor = bearer(issuer.mintAccessToken({ groups: ['editor'] }));
    await expect(auth.requireCan('content.publish', { request: editor })).resolves.toBeTruthy();
    const error = await rejection(auth.requireCan('people.manage', { request: editor }));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).status).toBe(403);
  });

  it('gives a member with no group no capabilities', async () => {
    const { auth, issuer } = harness();
    const error = await rejection(auth.requireCan('content.read', { request: bearer(issuer.mintAccessToken()) }));
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('grants nothing for a group missing from the capability map', async () => {
    const { auth, issuer } = harness();
    const error = await rejection(
      auth.requireCan('content.read', { request: bearer(issuer.mintAccessToken({ groups: ['made-up'] })) }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('includes app roles from the one capability file', async () => {
    const { auth, issuer } = harness();
    await expect(
      auth.requireCan('reviews.comment', { request: bearer(issuer.mintAccessToken({ groups: ['reviewer'] })) }),
    ).resolves.toBeTruthy();
  });

  it('checks any-of for requireGroup', async () => {
    const { auth, issuer } = harness();
    const req = bearer(issuer.mintAccessToken({ groups: ['admin'] }));
    await expect(auth.requireGroup(['superadmin', 'admin'], { request: req })).resolves.toBeTruthy();
    expect(await rejection(auth.requireGroup('superadmin', { request: req }))).toBeInstanceOf(ForbiddenError);
  });

  it('runs the authenticator rule before the role check', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setFactors('adm', { configured: ['PASSWORD'], mfa: [] });
    const error = await rejection(
      auth.requireCan('people.manage', { request: bearer(issuer.mintAccessToken({ sub: 'adm', groups: ['admin'] })) }),
    );
    expect(error).toBeInstanceOf(MfaEnrollmentRequiredError);
  });
});

describe('live checks for the admin area', () => {
  it("re-reads groups: a demoted admin is refused at once though the token still says admin", async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setLiveState('demoted', { enabled: true, groups: ['viewer'] });
    const req = bearer(issuer.mintAccessToken({ sub: 'demoted', groups: ['admin'] }));
    await expect(auth.requireCan('people.manage', { request: req })).resolves.toBeTruthy(); // token-only
    expect(await rejection(auth.requireCan('people.manage', { request: req, live: true }))).toBeInstanceOf(ForbiddenError);
  });

  it('refuses a disabled account with 401 account_disabled', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setLiveState('gone', { enabled: false, groups: ['admin'] });
    const error = await rejection(
      auth.requireCan('people.manage', {
        request: bearer(issuer.mintAccessToken({ sub: 'gone', groups: ['admin'] })),
        live: true,
      }),
    );
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as UnauthenticatedError).code).toBe('account_disabled');
  });

  it('returns the live groups on the user and caches them for about a minute', async () => {
    const { auth, issuer, cognito, clock } = harness();
    cognito.setLiveState('a', { enabled: true, groups: ['admin', 'reviewer'] });
    const req = bearer(issuer.mintAccessToken({ sub: 'a', groups: ['admin'] }));
    const user = await auth.requireCan('people.manage', { request: req, live: true });
    expect(user.live).toBe(true);
    expect(user.groups).toEqual(['admin', 'reviewer']);
    await auth.requireCan('people.manage', { request: req, live: true });
    expect(cognito.calls.filter((c) => c.method === 'getLiveUserState')).toHaveLength(1);
    clock.now += 61_000;
    await auth.requireCan('people.manage', { request: req, live: true });
    expect(cognito.calls.filter((c) => c.method === 'getLiveUserState')).toHaveLength(2);
  });

  it('invalidate() forgets cached results', async () => {
    const { auth, issuer, cognito } = harness();
    cognito.setLiveState('i', { enabled: true, groups: ['admin'] });
    const req = bearer(issuer.mintAccessToken({ sub: 'i', groups: ['admin'] }));
    const user = await auth.requireCan('people.manage', { request: req, live: true });
    cognito.setLiveState('i', { enabled: true, groups: [] });
    auth.invalidate(user);
    expect(await rejection(auth.requireCan('people.manage', { request: req, live: true }))).toBeInstanceOf(ForbiddenError);
  });
});

describe('step-up (auth_time)', () => {
  it('requires a sign-in within 5 minutes by default', async () => {
    const { auth, issuer, clock } = harness();
    const now = Math.floor(clock.now / 1000);
    const stale = bearer(issuer.mintAccessToken({ groups: ['superadmin'], authTime: now - 600 }));
    const error = await rejection(auth.requireCan('roles.manage', { request: stale, recentSignIn: true }));
    expect(error).toBeInstanceOf(StepUpRequiredError);
    expect((error as StepUpRequiredError).status).toBe(401);
    expect((error as StepUpRequiredError).maxAgeSeconds).toBe(300);

    const fresh = bearer(issuer.mintAccessToken({ groups: ['superadmin'], authTime: now - 60 }));
    await expect(auth.requireCan('roles.manage', { request: fresh, recentSignIn: true })).resolves.toBeTruthy();
  });

  it('accepts a custom maximum age and checks capability before asking to re-authenticate', async () => {
    const { auth, issuer, clock } = harness();
    const now = Math.floor(clock.now / 1000);
    const req = bearer(issuer.mintAccessToken({ groups: ['viewer'], authTime: now - 120 }));
    expect(await rejection(auth.requireCan('roles.manage', { request: req, recentSignIn: 60 }))).toBeInstanceOf(ForbiddenError);
    const user = await auth.requireUser({ request: req });
    expect(() => auth.requireRecentSignIn(user, 60)).toThrow(StepUpRequiredError);
    expect(() => auth.requireRecentSignIn(user, 600)).not.toThrow();
  });

  it('refuses a token with no auth_time outright (Cognito always issues one)', async () => {
    const { auth, issuer } = harness();
    const error = await rejection(auth.requireUser({ request: bearer(issuer.mintAccessToken({ claims: { auth_time: undefined } })) }));
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as UnauthenticatedError).code).toBe('invalid_token');
  });

  it('still treats a non-numeric authTime as stale (defense in depth)', async () => {
    const { auth, issuer } = harness();
    const user = await auth.requireUser({ request: bearer(issuer.mintAccessToken()) });
    expect(() => auth.requireRecentSignIn({ ...user, authTime: Number.NaN })).toThrow(StepUpRequiredError);
  });
});

describe('requireRecordAccess (IDOR)', () => {
  const record = { id: 'r1', ownerSub: 'owner-1', reviewers: ['rev-1'] };
  const rule = { owner: (r: typeof record) => r.ownerSub, members: (r: typeof record) => r.reviewers };

  it('allows the owner and members, refuses everyone else with 404', async () => {
    const { auth, issuer } = harness();
    const user = async (sub: string, groups: string[] = []) =>
      auth.requireUser({ request: bearer(issuer.mintAccessToken({ sub, groups })) });
    expect(auth.requireRecordAccess(await user('owner-1'), record, rule)).toBe(record);
    expect(auth.requireRecordAccess(await user('rev-1'), record, rule)).toBe(record);
    const stranger = await user('someone');
    expect(() => auth.requireRecordAccess(stranger, record, rule)).toThrow(NotFoundError);
  });

  it('allows a capability that covers every record', async () => {
    const { auth, issuer } = harness();
    const admin = await auth.requireUser({ request: bearer(issuer.mintAccessToken({ groups: ['admin'] })) });
    expect(auth.requireRecordAccess(admin, record, { ...rule, coveredBy: 'audit.read' })).toBe(record);
  });

  it('answers 404 for a missing record', async () => {
    const { auth, issuer } = harness();
    const u = await auth.requireUser({ request: bearer(issuer.mintAccessToken()) });
    expect(() => auth.requireRecordAccess(u, null, rule)).toThrow(NotFoundError);
  });
});
