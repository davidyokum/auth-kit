// @vitest-environment jsdom
/**
 * The first sign-in can't wedge anyone (2026-11-19, a real first sign-in on a deployed 0.1.19 site):
 *
 * 1. No password without an authenticator: a first password is held until the authenticator's code
 *    checks out, then saved, then the authenticator is turned on. Leaving halfway saves nothing.
 * 2. A setup key someone scanned stays valid: a remount, reload, or redirect shows the same key
 *    (kept per account in the tab); only "Get a new QR code" asks Cognito for another. A wrong code
 *    says to check the entry came from the key on screen.
 * 3. A new passkey refreshes the session (the server re-reads the factors; see test/server/auth.test.ts
 *    for "only 'nothing to set up' is cached").
 * 4. The passkey window opens from the click itself; a closed passkey prompt where the browser
 *    remembers no passkey says a first sign-in has none yet.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { AuthenticatorSetup, ChooseFirstCredential, SignIn, registerPasskey, setFirstPassword } from '../../src/client/index.js';
import { PROGRESS_TTL_MS, clearAuthenticatorProgress, readAuthenticatorProgress, saveAuthenticatorProgress } from '../../src/client/authenticator-progress.js';
import { checkAuthenticatorCode, turnOnAuthenticator } from '../../src/client/api.js';
import { auth, awsError, resetAmplifyMocks, TEST_SECRET } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const changePasswordWithoutPrevious = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/cognito.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CognitoModule>()),
  changePasswordWithoutPrevious,
}));

const SECOND_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

beforeEach(() => {
  resetAmplifyMocks();
  window.localStorage.clear();
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const setupKey = () => screen.getByLabelText('Setup key').textContent?.replace(/\s/g, '');

function chooser(extra: Record<string, unknown> = {}) {
  const onDone = vi.fn();
  render(createElement(ChooseFirstCredential, { passkeysEnabled: true, issuer: 'Example Reports', accountName: 'ada@example.org', onDone, checkBreachedPassword: false, ...extra }));
  return { onDone, user: userEvent.setup() };
}

async function choosePassword(user: ReturnType<typeof userEvent.setup>, password = 'a long enough password') {
  await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
  await user.type(await screen.findByLabelText('New password'), `${password}{Enter}`);
  await heading('Add an authenticator app');
}

describe('1. no password without an authenticator', () => {
  it('the chooser checks the code, then saves the password, then turns the authenticator on', async () => {
    const order: string[] = [];
    auth.verifyTOTPSetup.mockImplementation(() => {
      order.push('verifyTOTPSetup');
      return Promise.resolve();
    });
    changePasswordWithoutPrevious.mockImplementation(() => {
      order.push('ChangePassword');
      return Promise.resolve();
    });
    auth.updateMFAPreference.mockImplementation(() => {
      order.push('updateMFAPreference');
      return Promise.resolve();
    });
    const { user, onDone } = chooser();
    await choosePassword(user);
    expect(changePasswordWithoutPrevious).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('password'));
    expect(order).toEqual(['verifyTOTPSetup', 'ChangePassword', 'updateMFAPreference']);
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('leaving at the authenticator step saves nothing, and Back goes to the choice (a passkey is still open)', async () => {
    const { user, onDone } = chooser();
    await choosePassword(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Choose how you’ll sign in next time');
    expect(changePasswordWithoutPrevious).not.toHaveBeenCalled();
    expect(auth.verifyTOTPSetup).not.toHaveBeenCalled();
    expect(auth.updateMFAPreference).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a wrong code saves nothing', async () => {
    auth.verifyTOTPSetup.mockRejectedValueOnce(awsError('CodeMismatchException'));
    const { user } = chooser();
    await choosePassword(user);
    await user.type(await screen.findByLabelText('6-digit code'), '000000{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/If you scanned an earlier code, remove that entry/));
    expect(changePasswordWithoutPrevious).not.toHaveBeenCalled();
    expect(auth.updateMFAPreference).not.toHaveBeenCalled();
  });

  it('a password Cognito refuses goes back to the password with its reason, and the checked code isn’t asked for again', async () => {
    changePasswordWithoutPrevious.mockRejectedValueOnce(awsError('InvalidPasswordException', 'Password does not conform to policy'));
    const { user, onDone } = chooser();
    await choosePassword(user);
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await heading('Create a password');
    expect((await screen.findByRole('alert')).textContent).toMatch(/wasn’t accepted/);
    expect(auth.updateMFAPreference).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New password'), 'another long password{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('password'));
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(1);
    expect(auth.verifyTOTPSetup).toHaveBeenCalledTimes(1);
    expect(changePasswordWithoutPrevious).toHaveBeenLastCalledWith('another long password');
  });

  it('turning the authenticator on is tried twice; if it still fails, Try again finishes it without saving the password twice', async () => {
    auth.updateMFAPreference.mockRejectedValueOnce(awsError('NetworkError')).mockRejectedValueOnce(awsError('NetworkError'));
    const { user, onDone } = chooser();
    await choosePassword(user);
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await screen.findByText('Your code checked out. We’re finishing your authenticator setup.');
    expect(auth.updateMFAPreference).toHaveBeenCalledTimes(2);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('password'));
    expect(changePasswordWithoutPrevious).toHaveBeenCalledTimes(1);
    expect(auth.verifyTOTPSetup).toHaveBeenCalledTimes(1);
    expect(auth.updateMFAPreference).toHaveBeenCalledTimes(3);
  });

  it('the api: checkAuthenticatorCode only verifies; turnOnAuthenticator retries once, then refreshes', async () => {
    await checkAuthenticatorCode('123 456', 'Phone');
    expect(auth.verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456', options: { friendlyDeviceName: 'Phone' } });
    expect(auth.updateMFAPreference).not.toHaveBeenCalled();
    auth.updateMFAPreference.mockRejectedValueOnce(awsError('InternalErrorException'));
    await turnOnAuthenticator();
    expect(auth.updateMFAPreference).toHaveBeenCalledTimes(2);
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
    // A signed-out session isn't retried.
    auth.updateMFAPreference.mockReset().mockRejectedValue(awsError('NotAuthorizedException', 'Access Token has been revoked'));
    await expect(turnOnAuthenticator()).rejects.toThrow();
    expect(auth.updateMFAPreference).toHaveBeenCalledTimes(1);
  });

  it('setFirstPassword is still exported and unchanged for sites that call it themselves', async () => {
    await setFirstPassword('a long enough password');
    expect(changePasswordWithoutPrevious).toHaveBeenCalledWith('a long enough password');
  });
});

describe('2. a scanned setup key stays valid', () => {
  it('a remount (a reload, a redirect, StrictMode) shows the same key: setUpTOTP runs once', async () => {
    const first = render(createElement(StrictMode, null, createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' })));
    await screen.findByLabelText('6-digit code');
    expect(setupKey()).toBe(TEST_SECRET);
    first.unmount();
    auth.setUpTOTP.mockResolvedValue({ sharedSecret: SECOND_SECRET, getSetupUri: () => new URL('otpauth://totp/x') });
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await screen.findByLabelText('6-digit code');
    expect(setupKey()).toBe(TEST_SECRET);
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(1);
  });

  it('"Get a new QR code" is the one way to replace it', async () => {
    const user = userEvent.setup();
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await screen.findByLabelText('6-digit code');
    auth.setUpTOTP.mockResolvedValue({ sharedSecret: SECOND_SECRET, getSetupUri: () => new URL('otpauth://totp/x') });
    expect(screen.getByText('Scanned an older code, or lost this one?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Get a new QR code' }));
    await waitFor(() => expect(setupKey()).toBe(SECOND_SECRET));
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(2);
    expect(readAuthenticatorProgress('user-1')?.secret).toBe(SECOND_SECRET);
  });

  it('without a QR code it says "Get a new setup key"', async () => {
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org', renderQrCode: false }));
    expect(await screen.findByRole('button', { name: 'Get a new setup key' })).toBeTruthy();
  });

  it('another account in the same tab never gets this one’s key', async () => {
    saveAuthenticatorProgress('someone-else', { secret: SECOND_SECRET, checked: false, issuedAt: Date.now() });
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await screen.findByLabelText('6-digit code');
    expect(setupKey()).toBe(TEST_SECRET);
  });

  it('a kept key older than 30 minutes is replaced', async () => {
    saveAuthenticatorProgress('user-1', { secret: SECOND_SECRET, checked: false, issuedAt: Date.now() - PROGRESS_TTL_MS - 1 });
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await screen.findByLabelText('6-digit code');
    expect(setupKey()).toBe(TEST_SECRET);
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(1);
  });

  it('a code that already checked out finishes on the next screen without another code, and the key is then forgotten', async () => {
    saveAuthenticatorProgress('user-1', { secret: SECOND_SECRET, checked: true, issuedAt: Date.now() });
    const onDone = vi.fn();
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org', onDone }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(auth.setUpTOTP).not.toHaveBeenCalled();
    expect(auth.verifyTOTPSetup).not.toHaveBeenCalled();
    expect(auth.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
    expect(readAuthenticatorProgress('user-1')).toBeNull();
  });

  it('a wrong code says to check the entry came from the key on this screen', async () => {
    const user = userEvent.setup();
    auth.verifyTOTPSetup.mockRejectedValueOnce(awsError('CodeMismatchException', 'Invalid code received for user'));
    render(createElement(AuthenticatorSetup, { issuer: 'X', accountName: 'ada@example.org' }));
    await user.type(await screen.findByLabelText('6-digit code'), '000000{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'That code didn’t work. Enter the newest code from the entry you added with the QR code or setup key on this screen. If you scanned an earlier code, remove that entry. Then scan this one.',
      ),
    );
    // The key on screen is still the one to use: nothing replaced it.
    expect(setupKey()).toBe(TEST_SECRET);
    expect(auth.setUpTOTP).toHaveBeenCalledTimes(1);
  });

  it('the store: tab-scoped, keyed by account, refuses junk, and clears', () => {
    saveAuthenticatorProgress('a', { secret: TEST_SECRET, checked: false, issuedAt: 1_000 });
    expect(readAuthenticatorProgress('a', 1_000 + 60_000)).toEqual({ secret: TEST_SECRET, checked: false, issuedAt: 1_000 });
    expect(readAuthenticatorProgress('b', 1_000)).toBeNull();
    expect(window.localStorage.length).toBe(0);
    window.sessionStorage.setItem('auth-kit:authenticator-setup:v1:c', '{"secret":"<script>","checked":false,"issuedAt":1}');
    expect(readAuthenticatorProgress('c', 1)).toBeNull();
    clearAuthenticatorProgress('a');
    expect(readAuthenticatorProgress('a', 1_000)).toBeNull();
  });
});

describe('3. a new passkey refreshes the session', () => {
  it('registerPasskey refreshes after saving, and a failed refresh doesn’t undo the saved passkey', async () => {
    await registerPasskey();
    expect(auth.associateWebAuthnCredential).toHaveBeenCalled();
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
    auth.fetchAuthSession.mockRejectedValueOnce(awsError('NetworkError'));
    await expect(registerPasskey()).resolves.toBeUndefined();
  });
});

describe('4. the passkey window and the first sign-in', () => {
  it('"Create a passkey" starts the browser’s window inside the click, before the screen re-renders', async () => {
    let viewWhenCalled: string | null | undefined;
    auth.associateWebAuthnCredential.mockImplementation(() => {
      viewWhenCalled = document.querySelector('[data-auth-kit="choose-first-credential"]')?.getAttribute('data-auth-kit-view');
      return Promise.resolve();
    });
    const { user, onDone } = chooser();
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('passkey'));
    // Still the choice screen: the call ran in the click handler, not in an effect after the next render.
    expect(viewWhenCalled).toBe('choose');
    expect(auth.associateWebAuthnCredential).toHaveBeenCalledTimes(1);
  });

  it('Try again and "Use a passkey instead" start it inside their clicks too', async () => {
    auth.associateWebAuthnCredential.mockRejectedValueOnce(awsError('PasskeyRegistrationCanceled'));
    const { user, onDone } = chooser();
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await screen.findByText('We couldn’t create your passkey. Try again, or use a password instead.');
    let viewWhenCalled: string | null | undefined;
    auth.associateWebAuthnCredential.mockImplementationOnce(() => {
      viewWhenCalled = screen.queryByText('Waiting for your device…') ? 'waiting' : 'failed';
      return Promise.resolve();
    });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('passkey'));
    expect(viewWhenCalled).toBe('failed');
  });

  it('a closed passkey prompt where the browser remembers none says a first sign-in has no passkey yet', async () => {
    auth.signIn.mockRejectedValueOnce(awsError('PasskeyAuthenticationCanceled'));
    const user = userEvent.setup();
    render(createElement(SignIn, { siteName: 'Example Reports', help: { address: 'apps-help@example.org' }, passkeysEnabled: true, navigate: vi.fn(), loadFactors: vi.fn(), checkBreachedPassword: false }));
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await heading('How do you want to sign in?');
    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));
    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    const line = document.querySelector('[data-auth-kit="sign-in"] p[data-auth-kit-first-time]');
    expect(line?.textContent).toBe('First time signing in? You don’t have a passkey yet. Choose Email me a code, and you’ll set one up after.');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeTruthy();
  });
});
