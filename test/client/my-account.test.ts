// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { type ClientAuthFactors, MyAccount, type MyAccountProps, type MyAccountSelfService } from '../../src/client/index.js';
import { auth, awsError, resetAmplifyMocks } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const changePasswordWithoutPrevious = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/cognito.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CognitoModule>()),
  changePasswordWithoutPrevious,
}));

const MACBOOK = { credentialId: 'pk-1', friendlyCredentialName: 'MacBook', authenticatorAttachment: 'platform', createdAt: new Date('2026-10-01T12:00:00Z') };
const YUBIKEY = { credentialId: 'pk-2', friendlyCredentialName: 'Security key', authenticatorAttachment: 'cross-platform' };

function setup(factors: ClientAuthFactors | Error, props: Partial<MyAccountProps> = {}) {
  const navigate = vi.fn();
  const loadFactors = vi.fn(() => (factors instanceof Error ? Promise.reject(factors) : Promise.resolve(factors)));
  const user = userEvent.setup();
  render(createElement(MyAccount, { passkeysEnabled: true, issuer: 'Example Reports', navigate, loadFactors, checkBreachedPassword: false, ...props }));
  return { navigate, loadFactors, user };
}

const section = (name: string) => screen.getByRole('region', { name });

// No network from tests: anything that reaches the real fetch (Cognito's endpoint, a route) fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));

beforeEach(() => {
  resetAmplifyMocks();
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
});

describe('MyAccount', () => {
  it('shows the email, passkeys, authenticator, password, and sign out everywhere', async () => {
    auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [MACBOOK, YUBIKEY] });
    auth.fetchMFAPreference.mockResolvedValue({ enabled: ['TOTP'], preferred: 'TOTP' });
    setup({ configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    expect(screen.getByRole('heading', { name: 'My account', level: 1 })).toBeTruthy();
    expect(await within(section('Email')).findByText('ada@example.org')).toBeTruthy();
    expect(await within(section('Passkeys')).findByText('MacBook')).toBeTruthy();
    expect(within(section('Passkeys')).getByText(/On a device, added/)).toBeTruthy();
    expect(within(section('Passkeys')).getByText('(Security key or phone)')).toBeTruthy();
    expect(await within(section('Authenticator app')).findByText(/^On\./)).toBeTruthy();
    expect(within(section('Authenticator app')).getByRole('button', { name: 'Replace authenticator' })).toBeTruthy();
    expect(await within(section('Password')).findByText('You have a password.')).toBeTruthy();
    expect(within(section('Sign out everywhere')).getByText(/up to an hour/)).toBeTruthy();
  });

  it('hides passkeys before they are switched on', async () => {
    setup({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }, { passkeysEnabled: false });
    await screen.findByText('You have a password.');
    expect(screen.queryByRole('region', { name: 'Passkeys' })).toBeNull();
    expect(auth.listWebAuthnCredentials).not.toHaveBeenCalled();
  });

  it('removes a passkey after confirming', async () => {
    auth.listWebAuthnCredentials.mockResolvedValueOnce({ credentials: [MACBOOK, YUBIKEY] }).mockResolvedValueOnce({ credentials: [YUBIKEY] });
    const { user } = setup({ configured: ['WEB_AUTHN'], mfa: [] });
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    expect(screen.getByText(/You won’t be able to sign in with it/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
    expect(auth.deleteWebAuthnCredential).toHaveBeenCalledWith({ credentialId: 'pk-1' });
    await waitFor(() => expect(screen.queryByText('MacBook')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('Passkey removed.');
  });

  it('"Keep it" cancels a removal', async () => {
    auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [MACBOOK, YUBIKEY] });
    const { user } = setup({ configured: ['WEB_AUTHN'], mfa: [] });
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove passkey' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(auth.deleteWebAuthnCredential).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Passkeys' }));
  });

  it('refuses to remove the last way in', async () => {
    auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [MACBOOK] });
    const { user } = setup({ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    expect(screen.getByRole('alert').textContent).toMatch(/only way to sign in/);
    expect(screen.queryByRole('button', { name: 'Remove passkey' })).toBeNull();
    expect(auth.deleteWebAuthnCredential).not.toHaveBeenCalled();
  });

  it('allows removing the last passkey when a password remains', async () => {
    auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [MACBOOK] });
    const { user } = setup({ configured: ['WEB_AUTHN', 'PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await waitFor(() => expect(screen.getByText('You have a password.')).toBeTruthy());
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
    expect(auth.deleteWebAuthnCredential).toHaveBeenCalled();
  });

  it('fails closed on the last passkey when factors couldn’t load, and says so instead of showing "no password"', async () => {
    auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [MACBOOK] });
    const { user } = setup(awsError('NetworkError'));
    expect(await within(section('Password')).findByText(/Couldn’t load this/)).toBeTruthy();
    expect(within(section('Password')).queryByText(/don’t have a password/)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/couldn’t confirm/i);
  });

  it('shows a failed passkey list as a failure, not as "No passkeys yet"', async () => {
    auth.listWebAuthnCredentials.mockRejectedValueOnce(awsError('TooManyRequestsException')).mockResolvedValueOnce({ credentials: [MACBOOK] });
    const { user } = setup({ configured: ['WEB_AUTHN'], mfa: [] });
    const passkeys = section('Passkeys');
    expect(await within(passkeys).findByText(/Couldn’t load this. Too many attempts/)).toBeTruthy();
    expect(within(passkeys).queryByText('No passkeys yet.')).toBeNull();
    await user.click(within(passkeys).getByRole('button', { name: 'Try again' }));
    expect(await within(passkeys).findByText('MacBook')).toBeTruthy();
  });

  it('adds a passkey', async () => {
    auth.listWebAuthnCredentials.mockResolvedValueOnce({ credentials: [] }).mockResolvedValueOnce({ credentials: [MACBOOK] });
    const { user } = setup({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    expect(await screen.findByText('No passkeys yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a passkey' }));
    expect(auth.associateWebAuthnCredential).toHaveBeenCalled();
    expect(await screen.findByText('MacBook')).toBeTruthy();
  });

  it('explains a passkey that already exists on this device', async () => {
    auth.associateWebAuthnCredential.mockRejectedValue(awsError('PasskeyAlreadyExists'));
    const { user } = setup({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/already has a passkey/));
  });

  it('sets up the authenticator when it is off', async () => {
    auth.fetchMFAPreference.mockResolvedValueOnce({}).mockResolvedValueOnce({ enabled: ['TOTP'] });
    const { user } = setup({ configured: ['PASSWORD'], mfa: [] });
    expect(await within(section('Authenticator app')).findByText(/Off. You sign in with a password/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set up authenticator' }));
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    expect(await within(section('Authenticator app')).findByText(/^On\./)).toBeTruthy();
    expect(auth.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
  });

  it('changes a password, and says plainly when the current one is wrong', async () => {
    auth.updatePassword.mockRejectedValueOnce(awsError('NotAuthorizedException', 'Incorrect username or password.')).mockResolvedValueOnce(undefined);
    const { user } = setup({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await user.click(await screen.findByRole('button', { name: 'Change password' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Change your password' }));
    const current = screen.getByLabelText('Current password');
    expect(current.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByLabelText('New password').getAttribute('autocomplete')).toBe('new-password');
    await user.type(current, 'wrong');
    await user.type(screen.getByLabelText('New password'), 'a brand new long password{Enter}');
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => a.textContent === "Your current password isn’t right.")).toBe(true));
    await user.clear(screen.getByLabelText('Current password'));
    await user.type(screen.getByLabelText('Current password'), 'right');
    await user.type(screen.getByLabelText('New password'), '{Enter}');
    await waitFor(() => expect(auth.updatePassword).toHaveBeenLastCalledWith({ oldPassword: 'right', newPassword: 'a brand new long password' }));
    expect(await screen.findByText('Password changed.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Password' }));
  });

  it('sets a first password, then goes straight to the authenticator', async () => {
    const { user } = setup({ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] });
    expect(await screen.findByText(/You don’t have a password/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set a password' }));
    await user.type(screen.getByLabelText('New password'), 'fourteen chars{Enter}');
    expect(screen.getAllByRole('alert').some((a) => /at least 15/.test(a.textContent ?? ''))).toBe(true);
    await user.type(screen.getByLabelText('New password'), '!{Enter}');
    await waitFor(() => expect(changePasswordWithoutPrevious).toHaveBeenCalledWith('fourteen chars!'));
    expect(await screen.findByRole('heading', { name: 'Now add your authenticator' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('signs out everywhere, then leaves', async () => {
    const { user, navigate } = setup({ configured: ['WEB_AUTHN'], mfa: [] }, { signedOutPath: '/goodbye' });
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(auth.signOut).toHaveBeenCalledWith({ global: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/goodbye'));
  });

  it('marks the passkey and password headings with the fingerprint and password icons (decorative)', async () => {
    setup({ configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await screen.findByText('You have a password.');
    const passkeys = screen.getByRole('heading', { name: 'Passkeys' });
    const password = screen.getByRole('heading', { name: 'Password' });
    expect(passkeys.querySelector('svg[data-auth-kit-icon="fingerprint"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(password.querySelector('svg[data-auth-kit-icon="password"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Email' }).querySelector('svg')).toBeNull();
  });
});

describe('MyAccount self-service (sign-up sites)', () => {
  const FACTORS: ClientAuthFactors = { configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] };

  function selfService(overrides: Partial<{ [K in keyof MyAccountSelfService]: MyAccountSelfService[K] }> = {}) {
    return {
      requestEmailChange: vi.fn<MyAccountSelfService['requestEmailChange']>().mockResolvedValue({ ok: true, message: 'We emailed a code to new@example.org.' }),
      confirmEmailChange: vi.fn<MyAccountSelfService['confirmEmailChange']>().mockResolvedValue({ ok: true, message: 'Your email address is now new@example.org.' }),
      deleteMyAccount: vi.fn<MyAccountSelfService['deleteMyAccount']>().mockResolvedValue({ ok: true, message: 'Your account was deleted.' }),
      ...overrides,
    };
  }

  it('without self-service, the email is read-only: "ask the site’s admin", and there’s no delete', async () => {
    setup(FACTORS);
    const email = section('Email');
    expect(await within(email).findByText('ada@example.org')).toBeTruthy();
    expect(within(email).getByText('To change it, ask the site’s admin.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Delete your account' })).toBeNull();
  });

  it('changes the email: a code to the new address, then the change, and the page reads the new address', async () => {
    const actions = selfService();
    auth.fetchUserAttributes.mockResolvedValueOnce({ email: 'ada@example.org' }).mockResolvedValueOnce({ email: 'new@example.org' });
    const { user } = setup(FACTORS, { selfService: actions, siteName: 'Example Reports' });
    const email = section('Email');
    expect(await within(email).findByText('ada@example.org')).toBeTruthy();
    expect(within(email).queryByText('To change it, ask the site’s admin.')).toBeNull();
    await user.click(within(email).getByRole('button', { name: 'Change email' }));

    expect(within(email).getByRole('heading', { name: 'Change your email address' })).toBeTruthy();
    expect(within(email).getByText('We’ll email a code to the new address. The change happens once you enter it.')).toBeTruthy();
    const address = within(email).getByLabelText('New email address');
    expect(address.getAttribute('type')).toBe('email');
    expect(address.getAttribute('autocomplete')).toBe('email');
    await user.type(address, ' new@example.org ');
    await user.click(within(email).getByRole('button', { name: 'Send a code' }));
    expect(actions.requestEmailChange).toHaveBeenCalledWith({ newEmail: 'new@example.org' });
    expect(await within(email).findByText('We emailed a code to new@example.org.')).toBeTruthy();

    const code = within(email).getByLabelText('Code from the email');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    await user.type(code, '12345678');
    await user.click(within(email).getByRole('button', { name: 'Change email address' }));
    expect(actions.confirmEmailChange).toHaveBeenCalledWith({ code: '12345678' });
    const done = await within(email).findByText('Your email address is now new@example.org.');
    expect(done.getAttribute('role')).toBe('status');
    // New tokens carry the new address, and the section reads it again.
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
    expect(await within(email).findByText('new@example.org')).toBeTruthy();
    expect(within(email).getByRole('button', { name: 'Change email' })).toBeTruthy();
  });

  it('an action that needs a recent sign-in says so, with "Sign in again to confirm"', async () => {
    const actions = selfService({
      requestEmailChange: vi.fn<MyAccountSelfService['requestEmailChange']>().mockResolvedValue({ ok: false, code: 'step_up_required', error: 'For your security, sign in again first.' }),
    });
    const { user } = setup(FACTORS, { selfService: actions, stepUpHref: '/sign-in?reauth=1&next=%2Faccount' });
    const email = section('Email');
    await user.click(await within(email).findByRole('button', { name: 'Change email' }));
    await user.type(within(email).getByLabelText('New email address'), 'new@example.org');
    await user.click(within(email).getByRole('button', { name: 'Send a code' }));
    const alert = await within(email).findByRole('alert');
    expect(within(alert).getByText('For your security, sign in again first.')).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Sign in again to confirm' }).getAttribute('href')).toBe('/sign-in?reauth=1&next=%2Faccount');
    // Still on the address: nothing moved on.
    expect(within(email).getByLabelText('New email address')).toBeTruthy();
    expect(within(email).queryByLabelText('Code from the email')).toBeNull();
  });

  it('a failed action without a step-up link says only what went wrong; a thrown one says the site couldn’t be reached', async () => {
    const actions = selfService({
      requestEmailChange: vi
        .fn<MyAccountSelfService['requestEmailChange']>()
        .mockResolvedValueOnce({ ok: false, code: 'step_up_required', error: 'For your security, sign in again first.' })
        .mockRejectedValueOnce(new TypeError('Failed to fetch')),
    });
    const { user } = setup(FACTORS, { selfService: actions });
    const email = section('Email');
    await user.click(await within(email).findByRole('button', { name: 'Change email' }));
    await user.type(within(email).getByLabelText('New email address'), 'new@example.org');
    await user.click(within(email).getByRole('button', { name: 'Send a code' }));
    const alert = await within(email).findByRole('alert');
    expect(within(alert).queryByRole('link')).toBeNull();
    await user.click(within(email).getByRole('button', { name: 'Send a code' }));
    await waitFor(() => expect(within(email).getByRole('alert').textContent).toBe('We couldn’t reach the site just now. Try again in a moment.'));
  });

  it('deletes the account after the address is typed out, then leaves', async () => {
    const actions = selfService();
    const { user, navigate } = setup(FACTORS, { selfService: actions, siteName: 'Example Reports', itemsNote: 'Your reports stay with the team.', deletedPath: '/goodbye' });
    await screen.findByText('ada@example.org');
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeTruthy();
    expect(screen.getByText('Delete your account and the access that comes with it. You can’t undo this.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(screen.getByRole('heading', { name: 'Delete your Example Reports account?' })).toBeTruthy();
    expect(screen.getByText('This deletes your account and signs you out everywhere. Your reports stay with the team.')).toBeTruthy();
    const confirm = screen.getByLabelText('Type your email address to confirm');
    expect(confirm.getAttribute('placeholder')).toBe('ada@example.org');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete my account' });
    expect(submit.getAttribute('type')).toBe('submit');
    expect(submit.disabled).toBe(true);
    await user.type(confirm, 'ada@example.org');
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    expect(actions.deleteMyAccount).toHaveBeenCalledWith({ confirmEmail: 'ada@example.org' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/goodbye'));
  });

  it('a refused delete stays, with the reason and the step-up link; "Keep my account" closes it', async () => {
    const actions = selfService({
      deleteMyAccount: vi.fn<MyAccountSelfService['deleteMyAccount']>().mockResolvedValue({ ok: false, code: 'step_up_required', error: 'For your security, sign in again first.' }),
    });
    const { user, navigate } = setup(FACTORS, { selfService: actions, stepUpHref: '/sign-in?reauth=1' });
    await screen.findByText('ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    // No siteName: the heading leaves the name out rather than saying "this site".
    expect(screen.getByRole('heading', { name: 'Delete your account?' })).toBeTruthy();
    await user.type(screen.getByLabelText('Type your email address to confirm'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    expect((await screen.findByRole('link', { name: 'Sign in again to confirm' })).getAttribute('href')).toBe('/sign-in?reauth=1');
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep my account' }));
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeTruthy();
    expect(screen.queryByLabelText('Type your email address to confirm')).toBeNull();
  });
});
