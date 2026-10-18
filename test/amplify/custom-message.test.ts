import { describe, expect, it } from 'vitest';
import { ADMIN_API_CLIENT_ID, type CustomMessageTriggerEvent, SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED, customMessageHandler, customMessageKind } from '../../src/amplify/custom-message.js';

const handler = customMessageHandler({ siteName: 'Example Reports', theme: 'osbm', signInUrl: 'https://reports.example.org/sign-in', helpEmail: 'help@example.org', codeLifetimeMinutes: 10 });

/** The app client's ID, as Cognito sends it for a call made with a user's token (a placeholder). */
const APP_CLIENT_ID = '1example23456789abcdefghij';

function event(
  triggerSource: string,
  userAttributes: Record<string, string> = { email: 'a@example.org', email_verified: 'true' },
  clientId: string = APP_CLIENT_ID,
): CustomMessageTriggerEvent {
  return { triggerSource, callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId }, request: { userAttributes, codeParameter: '{####}', usernameParameter: null }, response: {} };
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
    expect((await handler(event('CustomMessage_UpdateUserAttribute', undefined, ADMIN_API_CLIENT_ID))).response.emailSubject).toBe('Confirm your new Example Reports email address');
    expect(customMessageKind(event('CustomMessage_VerifyUserAttribute'))).toBe('confirm-new-email');
  });
});

describe('the custom message trigger refuses email changes through Cognito’s public API (H1, ADR 0023)', () => {
  it('pins the admin API’s caller client ID', () => {
    expect(ADMIN_API_CLIENT_ID).toBe('CLIENT_ID_NOT_APPLICABLE');
  });

  it('refuses UpdateUserAttributes made with a user’s token: Cognito fails the call and sends no code', async () => {
    const e = event('CustomMessage_UpdateUserAttribute', { email: 'attacker@evil.example', email_verified: 'false' });
    await expect(handler(e)).rejects.toThrow(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED);
    // Nothing was written into the message: no code could go out even if Cognito used the event.
    expect(e.response.emailMessage).toBeUndefined();
    expect(e.response.emailSubject).toBeUndefined();
  });

  it('refuses a resent verification code (GetUserAttributeVerificationCode) made with a user’s token', async () => {
    await expect(handler(event('CustomMessage_VerifyUserAttribute'))).rejects.toThrow(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED);
  });

  it('refuses an event with no caller context, or any client ID but the admin API’s', async () => {
    const bare: CustomMessageTriggerEvent = { triggerSource: 'CustomMessage_UpdateUserAttribute', request: { userAttributes: { email: 'a@example.org' }, codeParameter: '{####}' }, response: {} };
    await expect(handler(bare)).rejects.toThrow(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED);
    for (const clientId of ['', 'client_id_not_applicable', 'CLIENT_ID_NOT_APPLICABLE ', 'CLIENT_ID_NOT_APPLICABLEx']) {
      await expect(handler(event('CustomMessage_UpdateUserAttribute', undefined, clientId)), clientId).rejects.toThrow(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED);
    }
  });

  it('lets the site’s server route through (AdminUpdateUserAttributes)', async () => {
    const e = await handler(event('CustomMessage_UpdateUserAttribute', { email: 'new@example.org', email_verified: 'false' }, ADMIN_API_CLIENT_ID));
    expect(e.response.emailMessage).toContain('{####}');
  });

  it('still sends sign-in and reset codes requested with the app client', async () => {
    expect((await handler(event('CustomMessage_Authentication'))).response.emailSubject).toBe('Your Example Reports sign-in code');
    expect((await handler(event('CustomMessage_ForgotPassword'))).response.emailSubject).toBe('Reset your Example Reports password');
  });

  it("leaves Cognito's own template for the admin pool's temporary password, and anything else", async () => {
    const e = await handler(event('CustomMessage_AdminCreateUser'));
    expect(e.response).toEqual({});
    expect((await handler(event('CustomMessage_SignUp'))).response).toEqual({});
  });

  it('refuses a missing or placeholder help address at load', () => {
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: 'https://x.example.org', helpEmail: '' })).toThrow(/help address/);
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: 'https://x.example.org', helpEmail: 'apps-help@replace-me.invalid' })).toThrow(/placeholder/);
  });

  it('refuses a bad configuration at load', () => {
    expect(() => customMessageHandler({ siteName: '', theme: 'osbm', signInUrl: 'https://x.example.org', helpEmail: 'help@example.org' })).toThrow(/siteName/);
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: '/sign-in', helpEmail: 'help@example.org' })).toThrow(/absolute URL/);
    expect(() => customMessageHandler({ siteName: 'X', theme: 'osbm', signInUrl: 'https://x.example.org', helpEmail: 'help@example.org', codeLifetimeMinutes: 30 })).toThrow(/3 to 15/);
  });
});
