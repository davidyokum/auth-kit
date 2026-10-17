// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatorSetup, type ClientAuthFactors, TOTPEnrollmentGate } from '../../src/client/index.js';
import { auth, awsError, resetAmplifyMocks, TEST_SECRET } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

beforeEach(() => resetAmplifyMocks());
afterEach(() => cleanup());

function gate(loadFactors: () => Promise<ClientAuthFactors>, extra: Record<string, unknown> = {}, child: ReturnType<typeof createElement> = createElement('p', null, 'The app')) {
  const onEnrolled = vi.fn();
  render(createElement(TOTPEnrollmentGate, { issuer: 'Example Reports', loadFactors, onEnrolled, ...extra }, child));
  return { onEnrolled };
}

/** The app is always in the page (the gate never skips its children); "shown" means not inside a hidden wrapper. */
function isShown(text: string): boolean {
  const element = screen.getByText(text);
  return element.closest('[hidden]') === null;
}

/** A child that counts its mounts, to see whether the gate remounts it. */
function mountCounter() {
  const mounts = { count: 0 };
  function Counted() {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return createElement('p', null, 'The app');
  }
  return { mounts, element: createElement(Counted) };
}

describe('TOTPEnrollmentGate', () => {
  it('shows the app to people who don’t need an authenticator', async () => {
    gate(() => Promise.resolve({ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] }));
    await waitFor(() => expect(isShown('The app')).toBe(true));
  });

  it('shows the app to password users who already have one', async () => {
    gate(() => Promise.resolve({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }));
    await waitFor(() => expect(isShown('The app')).toBe(true));
  });

  it('shows only setup to a password user without one, then the app, mounted afresh', async () => {
    const user = userEvent.setup();
    const counter = mountCounter();
    const { onEnrolled } = gate(() => Promise.resolve({ configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] }), {}, counter.element);
    await screen.findByRole('heading', { name: 'Set up your authenticator' });
    expect(isShown('The app')).toBe(false);
    expect(screen.getByText(/Example Reports also needs a code/)).toBeTruthy();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(isShown('The app')).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Set up your authenticator' })).toBeNull();
    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
    // Remounted after setup, so children such as MyAccount read the new state.
    expect(counter.mounts.count).toBe(2);
  });

  it('keeps the app hidden while checking, with a status (or the given fallback), and doesn’t remount it on success', async () => {
    let resolve!: (f: ClientAuthFactors) => void;
    const counter = mountCounter();
    gate(() => new Promise((r) => (resolve = r)), {}, counter.element);
    expect(screen.getByRole('status').textContent).toBe('Checking your account…');
    expect(isShown('The app')).toBe(false);
    resolve({ configured: ['WEB_AUTHN'], mfa: [] });
    await waitFor(() => expect(isShown('The app')).toBe(true));
    expect(screen.queryByText('Checking your account…')).toBeNull();
    expect(counter.mounts.count).toBe(1);
    cleanup();

    gate(() => new Promise(() => undefined), { fallback: createElement('p', null, 'Loading…') });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(isShown('The app')).toBe(false);
  });

  it('fails closed: if the check can’t run, the app stays hidden and the reason is shown with a retry', async () => {
    const user = userEvent.setup();
    const loadFactors = vi
      .fn<() => Promise<ClientAuthFactors>>()
      .mockRejectedValueOnce(awsError('NetworkError'))
      .mockResolvedValueOnce({ configured: ['WEB_AUTHN'], mfa: [] });
    gate(loadFactors);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't check your sign-in settings.*connection/i));
    expect(isShown('The app')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(isShown('The app')).toBe(true));
    expect(loadFactors).toHaveBeenCalledTimes(2);
  });

  it('marks its state for styling, and keeps the app in a content slot', async () => {
    gate(() => Promise.resolve({ configured: ['WEB_AUTHN'], mfa: [] }), { classNames: { content: 'app-body' } });
    const root = document.querySelector('[data-auth-kit="totp-gate"]')!;
    await waitFor(() => expect(root.getAttribute('data-auth-kit-state')).toBe('open'));
    const content = root.querySelector('[data-auth-kit-slot="content"]')!;
    expect(content.className).toBe('app-body');
    expect(content.hasAttribute('hidden')).toBe(false);
    expect(content.textContent).toBe('The app');
  });

  describe('serverChecked (the page’s own guard already ran)', () => {
    it('shows the app from the first render, before the browser check answers', async () => {
      let resolve!: (f: ClientAuthFactors) => void;
      const counter = mountCounter();
      gate(() => new Promise((r) => (resolve = r)), { serverChecked: true }, counter.element);
      expect(isShown('The app')).toBe(true);
      expect(screen.queryByText('Checking your account…')).toBeNull();
      resolve({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
      await waitFor(() => expect(counter.mounts.count).toBe(1));
      expect(isShown('The app')).toBe(true);
    });

    it('still switches to setup when the browser says the person needs an authenticator', async () => {
      gate(() => Promise.resolve({ configured: ['PASSWORD'], mfa: [] }), { serverChecked: true });
      await screen.findByRole('heading', { name: 'Set up your authenticator' });
      expect(isShown('The app')).toBe(false);
    });

    it('keeps the app when the browser re-check can’t run: the server’s answer stands', async () => {
      const loadFactors = vi.fn<() => Promise<ClientAuthFactors>>().mockRejectedValue(awsError('NetworkError'));
      gate(loadFactors, { serverChecked: true });
      await waitFor(() => expect(loadFactors).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(isShown('The app')).toBe(true);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
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
