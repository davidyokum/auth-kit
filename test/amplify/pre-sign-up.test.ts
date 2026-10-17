import { describe, expect, it } from 'vitest';
import { isAllowedEmail, preSignUpAllowlist, type PreSignUpTriggerEvent } from '../../src/amplify/pre-sign-up.js';

function event(triggerSource: string, email?: string): PreSignUpTriggerEvent {
  return { triggerSource, request: { userAttributes: email === undefined ? {} : { email } }, response: {} };
}

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

  it('allows subdomains only when asked', () => {
    expect(isAllowedEmail('a@cs.example.edu', { allowedEmailDomains: ['example.edu'], allowSubdomains: true })).toBe(true);
    expect(isAllowedEmail('a@notexample.edu', { allowedEmailDomains: ['example.edu'], allowSubdomains: true })).toBe(false);
  });
});

describe('preSignUpAllowlist', () => {
  const handler = preSignUpAllowlist({ allowedEmailDomains: ['example.edu'] });

  it('allows an allowlisted self sign-up and never auto-confirms or auto-verifies', async () => {
    const result = await handler(event('PreSignUp_SignUp', 'a@example.edu'));
    expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });

  it('refuses other domains with a generic message', async () => {
    await expect(handler(event('PreSignUp_SignUp', 'a@gmail.example'))).rejects.toThrow('Sign-up is limited to approved email domains.');
    await expect(handler(event('PreSignUp_SignUp'))).rejects.toThrow();
  });

  it('applies the allowlist to federated first sign-ins too', async () => {
    await expect(handler(event('PreSignUp_ExternalProvider', 'a@other.example'))).rejects.toThrow();
  });

  it('lets admin-created users (invites) through untouched', async () => {
    const e = event('PreSignUp_AdminCreateUser', 'anyone@anywhere.example');
    expect(await handler(e)).toBe(e);
    expect(e.response).toEqual({});
  });

  it('refuses a bad configuration', () => {
    expect(() => preSignUpAllowlist({ allowedEmailDomains: [] })).toThrow(/at least one/);
    expect(() => preSignUpAllowlist({ allowedEmailDomains: ['not a domain'] })).toThrow(/valid domain/);
  });
});
