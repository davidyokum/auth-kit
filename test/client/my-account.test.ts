// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { type ClientAuthFactors, MyAccount, type MyAccountProps } from '../../src/client/index.js';
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

beforeEach(() => {
  resetAmplifyMocks();
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

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
    expect(screen.getByText(/You won't be able to sign in with it/)).toBeTruthy();
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
    expect(await within(section('Password')).findByText(/Couldn't load this/)).toBeTruthy();
    expect(within(section('Password')).queryByText(/don't have a password/)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Remove MacBook' }));
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/couldn't confirm/i);
  });

  it('shows a failed passkey list as a failure, not as "No passkeys yet"', async () => {
    auth.listWebAuthnCredentials.mockRejectedValueOnce(awsError('TooManyRequestsException')).mockResolvedValueOnce({ credentials: [MACBOOK] });
    const { user } = setup({ configured: ['WEB_AUTHN'], mfa: [] });
    const passkeys = section('Passkeys');
    expect(await within(passkeys).findByText(/Couldn't load this. Too many attempts/)).toBeTruthy();
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
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => a.textContent === "Your current password isn't right.")).toBe(true));
    await user.clear(screen.getByLabelText('Current password'));
    await user.type(screen.getByLabelText('Current password'), 'right');
    await user.type(screen.getByLabelText('New password'), '{Enter}');
    await waitFor(() => expect(auth.updatePassword).toHaveBeenLastCalledWith({ oldPassword: 'right', newPassword: 'a brand new long password' }));
    expect(await screen.findByText('Password changed.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Password' }));
  });

  it('sets a first password, then goes straight to the authenticator', async () => {
    const { user } = setup({ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] });
    expect(await screen.findByText(/You don't have a password/)).toBeTruthy();
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
});
