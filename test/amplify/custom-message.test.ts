import { describe, expect, it } from 'vitest';
import { type CustomMessageTriggerEvent, customMessageHandler, customMessageKind } from '../../src/amplify/custom-message.js';

const handler = customMessageHandler({ siteName: 'Example Reports', theme: 'osbm', signInUrl: 'https://reports.example.org/sign-in', helpEmail: 'help@example.org', codeLifetimeMinutes: 10 });

function event(triggerSource: string, userAttributes: Record<string, string> = { email: 'a@example.org', email_verified: 'true' }): CustomMessageTriggerEvent {
  return { triggerSource, request: { userAttributes, codeParameter: '{####}', usernameParameter: null }, response: {} };
}

describe('the custom message trigger (ADR 0024)', () => {
  it('words an emailed sign-in code with the code lifetime', async () => {
    const e = await handler(event('CustomMessage_Authentication'));
    expect(e.response.emailSubject).toBe('Your Example Reports sign-in code');
    expect(e.response.emailMessage).toContain('{####}');
    expect(e.response.emailMessage).toContain('It works for 10 minutes.');
  });

  it('words the first code to an unverified sign-up account as the code to create an account', async () => {
    const signUp = { email: 'a@example.org', email_verified: 'false', 'custom:authkit_origin': 'signup' };
    const e = await handler(event('CustomMessage_Authentication', signUp));
    expect(e.response.emailSubject).toBe('Your Example Reports code');
    expect(e.response.emailMessage).toContain('Your code to create an account');
    expect(customMessageKind(event('CustomMessage_Authentication', { ...signUp, email_verified: 'true' }))).toBe('sign-in-code');
    expect(customMessageKind(event('CustomMessage_Authentication', { email: 'a@example.org', email_verified: 'false' }))).toBe('sign-in-code');
  });

  it('words a reset and a new-address confirmation', async () => {
    expect((await handler(event('CustomMessage_ForgotPassword'))).response.emailSubject).toBe('Reset your Example Reports password');
    expect((await handler(event('CustomMessage_UpdateUserAttribute'))).response.emailSubject).toBe('Confirm your new Example Reports email address');
    expect(customMessageKind(event('CustomMessage_VerifyUserAttribute'))).toBe('confirm-new-email');
  });

  it("leaves Cognito's own template for the admin pool's temporary password, and anything else", async () => {
    const e = await handler(event('CustomMessage_AdminCreateUser'));
    expect(e.response).toEqual({});
    expect((await handler(event('CustomMessage_SignUp'))).response).toEqual({});
  });

  it('refuses a bad configuration at load', () => {
    expect(() => customMessageHandler({ siteName: '', theme: 'osbm', signInUrl: 'https://x.example.org' })).toThrow(/siteName/);
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: '/sign-in' })).toThrow(/absolute URL/);
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: 'https://x.example.org', codeLifetimeMinutes: 30 })).toThrow(/3 to 15/);
  });
});
