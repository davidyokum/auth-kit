// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatorSetup, type ClientAuthFactors, TOTPEnrollmentGate } from '../../src/client/index.js';
import { auth, awsError, resetAmplifyMocks, TEST_SECRET } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

beforeEach(() => resetAmplifyMocks());
afterEach(() => cleanup());

function gate(loadFactors: () => Promise<ClientAuthFactors>, extra: Record<string, unknown> = {}) {
  const onEnrolled = vi.fn();
  render(createElement(TOTPEnrollmentGate, { issuer: 'Example Reports', loadFactors, onEnrolled, ...extra }, createElement('p', null, 'The app')));
  return { onEnrolled };
}

describe('TOTPEnrollmentGate', () => {
  it('shows the app to people who don’t need an authenticator', async () => {
    gate(() => Promise.resolve({ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] }));
    expect(await screen.findByText('The app')).toBeTruthy();
  });

  it('shows the app to password users who already have one', async () => {
    gate(() => Promise.resolve({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }));
    expect(await screen.findByText('The app')).toBeTruthy();
  });

  it('shows only setup to a password user without one, then the app', async () => {
    const user = userEvent.setup();
    const { onEnrolled } = gate(() => Promise.resolve({ configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] }));
    await screen.findByRole('heading', { name: 'Set up your authenticator' });
    expect(screen.queryByText('The app')).toBeNull();
    expect(screen.getByText(/Example Reports also needs a code/)).toBeTruthy();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    expect(await screen.findByText('The app')).toBeTruthy();
    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('keeps the app hidden while checking, with a status (or the given fallback)', async () => {
    let resolve!: (f: ClientAuthFactors) => void;
    gate(() => new Promise((r) => (resolve = r)));
    expect(screen.getByRole('status').textContent).toBe('Checking your account…');
    expect(screen.queryByText('The app')).toBeNull();
    resolve({ configured: ['WEB_AUTHN'], mfa: [] });
    expect(await screen.findByText('The app')).toBeTruthy();
    cleanup();

    gate(() => new Promise(() => undefined), { fallback: createElement('p', null, 'Loading…') });
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('fails closed: if the check can’t run, the app stays hidden and the reason is shown with a retry', async () => {
    const user = userEvent.setup();
    const loadFactors = vi
      .fn<() => Promise<ClientAuthFactors>>()
      .mockRejectedValueOnce(awsError('NetworkError'))
      .mockResolvedValueOnce({ configured: ['WEB_AUTHN'], mfa: [] });
    gate(loadFactors);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't check your sign-in settings.*connection/i));
    expect(screen.queryByText('The app')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The app')).toBeTruthy();
    expect(loadFactors).toHaveBeenCalledTimes(2);
  });
});

describe('AuthenticatorSetup', () => {
  it('starts one setup even under StrictMode, labels it with the account email, and offers the key', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onDone = vi.fn();
    render(createElement(StrictMode, null, createElement(AuthenticatorSetup, { issuer: 'Example Reports', onDone })));
    const link = await screen.findByRole('link', { name: 'Open the setup link' });
    await waitFor(() => expect(link.getAttribute('href')).toContain('Example%20Reports:ada%40example.org'));
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(1);
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Copy setup key' }));
    expect(writeText).toHaveBeenCalledWith(TEST_SECRET);
    expect(screen.getByRole('status').textContent).toBe('Setup key copied.');

    await user.type(screen.getByLabelText('6-digit code'), '12 34{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Enter the 6-digit code from your authenticator.');
    expect(document.activeElement).toBe(screen.getByLabelText('6-digit code'));
    await user.type(screen.getByLabelText('6-digit code'), '56{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(auth.verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456' });
  });

  it('explains a wrong code and clears the field for the next one', async () => {
    const user = userEvent.setup();
    auth.verifyTOTPSetup.mockRejectedValueOnce(awsError('EnableSoftwareTokenMFAException', 'Code mismatch'));
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await user.type(await screen.findByLabelText('6-digit code'), '000000{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/isn't right/));
    expect(screen.getByLabelText<HTMLInputElement>('6-digit code').value).toBe('');
    expect(screen.getByLabelText('6-digit code').getAttribute('aria-invalid')).toBe('true');
  });

  it('says why setup couldn’t start, and retries', async () => {
    const user = userEvent.setup();
    auth.setUpTOTP.mockRejectedValueOnce(awsError('NotAuthorizedException', 'Access Token has been revoked'));
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/session has ended/));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('6-digit code')).toBeTruthy();
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(2);
  });

  it('renders a site-provided QR code for the setup link', async () => {
    const renderQrCode = vi.fn((uri: string) => createElement('img', { alt: 'QR code', 'data-uri': uri }));
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org', renderQrCode }));
    const img = await screen.findByAltText('QR code');
    expect(img.getAttribute('data-uri')).toMatch(/^otpauth:\/\/totp\/X:ada%40example.org\?secret=/);
  });
});
