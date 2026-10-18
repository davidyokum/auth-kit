import { describe, expect, it } from 'vitest';
import { PRE_SIGN_UP_REFUSED, isAllowedEmail, preSignUpAllowlist, preSignUpForAccountCreation, type PreSignUpTriggerEvent } from '../../src/amplify/pre-sign-up.js';

function event(triggerSource: string, email?: string, extra: Record<string, string> = {}): PreSignUpTriggerEvent {
  return { triggerSource, request: { userAttributes: { ...(email === undefined ? {} : { email }), ...extra } }, response: {} };
}
const SIGN_UP = { 'custom:authkit_origin': 'signup' };

describe('isAllowedEmail', () => {
  const options = { allowedEmailDomains: ['example.edu'] };
  it.each([
    ['person@example.edu', true],
    ['Person@EXAMPLE.EDU', true],
    ['  person@example.edu  ', true],
    ['person@cs.example.edu', false],
    ['person@evil-example.edu', false],
    ['person@example.edu.evil.org', false],
    ['person@exampleXedu', false],
    ['example.edu@evil.org', false],
    ['@example.edu', false],
    ['person@', false],
    ['person', false],
    ['', false],
  ])('%s -> %s', (email, allowed) => {
    expect(isAllowedEmail(email, options)).toBe(allowed);
  });

  describe('address parsing (L8)', () => {
    const C = String.fromCharCode;
    it.each([
      ['a@evil.example@example.edu', 'two @ signs'],
      ['"a@b"@example.edu', 'a quoted local part'],
      [`a${C(0)}b@example.edu`, 'a NUL in the local part'],
      [`a${C(10)}@example.edu`, 'a newline'],
      [`a${C(9)}b@example.edu`, 'a tab'],
      ['a b@example.edu', 'a space inside'],
      [`a@example.edu${C(13)}`, 'a trailing carriage return'],
      ['.a@example.edu', 'a leading dot'],
      ['a.@example.edu', 'a trailing dot'],
      ['a..b@example.edu', 'a doubled dot'],
      [`${'a'.repeat(65)}@example.edu`, 'a local part over 64 characters'],
      [`a@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.example.edu`, 'an address over 254 characters'],
      [`a@example.edu${C(0x200b)}`, 'a zero-width space'],
    ])('refuses %j (%s)', (email) => {
      expect(isAllowedEmail(email, { allowedEmailDomains: ['example.edu'], allowSubdomains: true })).toBe(false);
    });

    it.each(['first.last@example.edu', 'a+tag@example.edu', "o'brien@example.edu", 'x_y-z@example.edu'])('accepts %s', (email) => {
      expect(isAllowedEmail(email, { allowedEmailDomains: ['example.edu'] })).toBe(true);
    });

    it('refuses a non-string', () => {
      expect(isAllowedEmail(undefined as never, { allowedEmailDomains: ['example.edu'] })).toBe(false);
    });
  });

  it('allows subdomains only when asked', () => {
    expect(isAllowedEmail('a@cs.example.edu', { allowedEmailDomains: ['example.edu'], allowSubdomains: true })).toBe(true);
    expect(isAllowedEmail('a@notexample.edu', { allowedEmailDomains: ['example.edu'], allowSubdomains: true })).toBe(false);
  });
});

describe('preSignUpForAccountCreation (ADR 0023)', () => {
  const domains = preSignUpForAccountCreation({ accountCreation: { mode: 'domains', domains: ['example.edu'] } });

  it("refuses Cognito's own SignUp in every mode (the pool has it off; this is the second lock)", async () => {
    for (const accountCreation of [{ mode: 'invite' }, { mode: 'request' }, { mode: 'domains', domains: ['example.edu'] }, { mode: 'open' }] as const) {
      const handler = preSignUpForAccountCreation({ accountCreation });
      await expect(handler(event('PreSignUp_SignUp', 'a@example.edu'))).rejects.toThrow(PRE_SIGN_UP_REFUSED);
    }
  });

  it("re-checks the domain list on accounts the sign-up route made, and never auto-confirms or auto-verifies", async () => {
    const ok = await domains(event('PreSignUp_AdminCreateUser', 'a@cs.example.edu', SIGN_UP));
    expect(ok.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
    await expect(domains(event('PreSignUp_AdminCreateUser', 'a@gmail.example', SIGN_UP))).rejects.toThrow(PRE_SIGN_UP_REFUSED);
    await expect(domains(event('PreSignUp_AdminCreateUser', 'a@evilexample.edu', SIGN_UP))).rejects.toThrow();
    await expect(domains(event('PreSignUp_AdminCreateUser', undefined, SIGN_UP))).rejects.toThrow();
  });

  it('lets admin invites (no sign-up mark) through, to any address', async () => {
    const e = event('PreSignUp_AdminCreateUser', 'anyone@anywhere.example');
    expect(await domains(e)).toBe(e);
  });

  it('refuses a sign-up mark with an unexpected value, and sign-up accounts where the mode has no sign-up', async () => {
    await expect(domains(event('PreSignUp_AdminCreateUser', 'a@example.edu', { 'custom:authkit_origin': 'admin' }))).rejects.toThrow();
    for (const mode of ['invite', 'request'] as const) {
      const handler = preSignUpForAccountCreation({ accountCreation: { mode } });
      await expect(handler(event('PreSignUp_AdminCreateUser', 'a@example.edu', SIGN_UP))).rejects.toThrow();
    }
  });

  it('takes anyone in open mode', async () => {
    const open = preSignUpForAccountCreation({ accountCreation: { mode: 'open' } });
    await expect(open(event('PreSignUp_AdminCreateUser', 'a@anywhere.example', SIGN_UP))).resolves.toBeTruthy();
    await expect(open(event('PreSignUp_AdminCreateUser', 'not an address', SIGN_UP))).rejects.toThrow();
  });

  it('treats federated first sign-ins as sign-ups', async () => {
    await expect(domains(event('PreSignUp_ExternalProvider', 'a@example.edu'))).resolves.toBeTruthy();
    await expect(domains(event('PreSignUp_ExternalProvider', 'a@other.example'))).rejects.toThrow();
    await expect(preSignUpForAccountCreation({ accountCreation: { mode: 'invite' } })(event('PreSignUp_ExternalProvider', 'a@example.edu'))).rejects.toThrow();
  });

  it('refuses a bad configuration at build', () => {
    expect(() => preSignUpForAccountCreation({ accountCreation: { mode: 'domains', domains: [] } })).toThrow(/at least one/);
  });
});

describe('preSignUpAllowlist (removed)', () => {
  it('throws, explaining the change', () => {
    expect(() => preSignUpAllowlist({ allowedEmailDomains: ['example.edu'] })).toThrow(/removed in 0.1.8 \(ADR 0023\).*preSignUpForAccountCreation/s);
  });
});
