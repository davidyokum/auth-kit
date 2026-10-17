// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { type ClientAuthFactors, SignIn, type SignInProps } from '../../src/client/index.js';
import { auth, awsError, next, resetAmplifyMocks, SIGNED_IN, TEST_SECRET } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const changePasswordWithoutPrevious = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/cognito.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CognitoModule>()),
  changePasswordWithoutPrevious,
}));

const DONE_FACTORS: ClientAuthFactors = { configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] };

function setup(props: Partial<SignInProps> = {}, factors: ClientAuthFactors[] = [DONE_FACTORS]) {
  const navigate = vi.fn();
  const queue = [...factors];
  const loadFactors = vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!));
  const user = userEvent.setup();
  render(
    createElement(SignIn, {
      siteName: 'Example Reports',
      passkeysEnabled: true,
      next: '/reports/42?tab=notes',
      navigate,
      loadFactors,
      checkBreachedPassword: false,
      ...props,
    }),
  );
  return { navigate, loadFactors, user };
}

const alert = () => screen.getAllByRole('alert')[0]!;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

beforeEach(() => {
  resetAmplifyMocks();
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('the start screen', () => {
  it('leads with the passkey and marks the email field for password managers', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Sign in to Example Reports', level: 1 })).toBeTruthy();
    const email = screen.getByLabelText('Email address');
    expect(email.getAttribute('autocomplete')).toBe('username webauthn');
    expect(email.getAttribute('type')).toBe('email');
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a code instead' })).toBeTruthy();
  });

  it('starts on the password form when passkeys are off, and hides emailed codes when the pool has none', () => {
    setup({ passkeysEnabled: false, emailCodeEnabled: false });
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Email me a code/ })).toBeNull();
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  });

  it('asks for an email before calling Cognito, and announces it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    expect(alert().textContent).toBe('Enter your email address.');
    const email = screen.getByLabelText('Email address');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toContain(alert().id);
    expect(document.activeElement).toBe(email);
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});

describe('passkey sign-in', () => {
  it('signs in and goes to the safe `next` path', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
    expect(auth.signIn).toHaveBeenCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } });
  });

  it('never redirects off-site', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ next: '//evil.example/steal', defaultNext: '/home' });
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home'));
  });

  it('honors allowed redirect prefixes', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ next: '/admin/people', allowedRedirectPrefixes: ['/reports'] });
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('explains a closed passkey prompt and keeps the other ways in', async () => {
    auth.signIn.mockRejectedValue(awsError('PasskeyAuthenticationCanceled'));
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/passkey prompt closed/));
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
  });

  it('SELECT_CHALLENGE: offers what Cognito allows, then password and TOTP in the same session', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['PASSWORD', 'PASSWORD_SRP', 'EMAIL_OTP'] }));
    auth.confirmSignIn
      .mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_PASSWORD' }))
      .mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }))
      .mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');

    expect(document.activeElement).toBe(await heading('Choose how to sign in'));
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use your password' }));
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'PASSWORD' });

    await heading('Enter your password');
    await user.type(screen.getByLabelText('Password'), 'my password{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'my password' });

    await heading('Enter your authenticator code');
    const code = screen.getByLabelText('6-digit code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    await user.type(code, '123 456{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '123456' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('SELECT_CHALLENGE with nothing this site offers says so', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['SMS_OTP'] }));
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/can't sign in here/));
  });
});

describe('password sign-in', () => {
  async function submitPassword(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
    await heading('Sign in to Example Reports');
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'my long password{Enter}');
  }

  it('password, then the TOTP challenge', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup();
    await submitPassword(user);
    expect(auth.signIn).toHaveBeenCalledWith({
      username: 'ada@example.org',
      password: 'my long password',
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
    });
    await heading('Enter your authenticator code');
    expect(screen.getByText(/Ask the site's admin to reset it/)).toBeTruthy();
    await user.type(screen.getByLabelText('6-digit code'), '12345{Enter}');
    expect(alert().textContent).toBe('Enter the 6-digit code from your authenticator.');
    await user.type(screen.getByLabelText('6-digit code'), '6{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
  });

  it('a wrong TOTP code keeps the session and marks the field', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    auth.confirmSignIn.mockRejectedValueOnce(awsError('CodeMismatchException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup();
    await submitPassword(user);
    await heading('Enter your authenticator code');
    await user.type(screen.getByLabelText('6-digit code'), '000000{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/current 6-digit code/));
    expect(screen.getByLabelText('6-digit code').getAttribute('aria-invalid')).toBe('true');
    await user.clear(screen.getByLabelText('6-digit code'));
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('says the same thing for a wrong password and an unknown account', async () => {
    const messages: string[] = [];
    for (const error of [awsError('NotAuthorizedException', 'Incorrect username or password.'), awsError('UserNotFoundException', 'User does not exist.')]) {
      auth.signIn.mockRejectedValueOnce(error);
      const { user } = setup();
      await submitPassword(user);
      await waitFor(() => expect(alert().textContent).not.toBe(''));
      messages.push(alert().textContent ?? '');
      expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
      cleanup();
    }
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toMatch(/don't match/);
  });

  it('tells people to wait when rate-limited (Cognito or WAF)', async () => {
    auth.signIn.mockRejectedValue(awsError('ForbiddenException', 'Request not allowed due to WAF block.'));
    const { user } = setup();
    await submitPassword(user);
    await waitFor(() => expect(alert().textContent).toBe('Too many attempts. Wait a few minutes, then try again.'));
  });

  it('starts over with the email kept when the 3-minute session expires', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    auth.confirmSignIn.mockRejectedValue(awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.'));
    const { user } = setup();
    await submitPassword(user);
    await heading('Enter your authenticator code');
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await heading('Sign in to Example Reports');
    expect(alert().textContent).toMatch(/timed out/);
    expect(screen.getByLabelText<HTMLInputElement>('Email address').value).toBe('ada@example.org');
  });

  it('PasswordResetRequired: resets by emailed code, then back to sign-in', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'RESET_PASSWORD' }));
    const { user } = setup();
    await submitPassword(user);
    await heading('Reset your password');
    expect(screen.getByRole('status').textContent).toMatch(/choose a new password/);
    await user.click(screen.getByRole('button', { name: 'Email me a reset code' }));
    expect(auth.resetPassword).toHaveBeenCalledWith({ username: 'ada@example.org' });

    await heading('Set a new password');
    await user.type(screen.getByLabelText('Code from the email'), '12345678');
    await user.type(screen.getByLabelText('New password'), 'too short{Enter}');
    expect(alert().textContent).toMatch(/at least 15/);
    await user.type(screen.getByLabelText('New password'), ' but now long enough{Enter}');
    await heading('Sign in to Example Reports');
    expect(auth.confirmResetPassword).toHaveBeenCalledWith({
      username: 'ada@example.org',
      confirmationCode: '12345678',
      newPassword: 'too short but now long enough',
    });
    expect(screen.getByRole('status').textContent).toBe('Password saved. Sign in with your new password.');
  });

  it('"Forgot your password?" answers the same whether or not the account exists', async () => {
    auth.resetPassword.mockRejectedValue(awsError('UserNotFoundException'));
    const { user } = setup({ passkeysEnabled: false });
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText('Email address'), 'nobody@example.org{Enter}');
    await heading('Set a new password');
    expect(screen.getByText(/If an account uses nobody@example.org/)).toBeTruthy();
  });
});

describe('emailed code (the backstop) and joining', () => {
  it('sends a code, retries a wrong one, then a fresh invite saves a passkey', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } }));
    auth.confirmSignIn.mockRejectedValueOnce(awsError('CodeMismatchException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({}, [{ configured: ['EMAIL_OTP'], mfa: [] }, DONE_FACTORS]);
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
    expect(auth.signIn.mock.calls[0]![0].options.preferredChallenge).toBe('EMAIL_OTP');

    await heading('Check your email');
    expect(screen.getByRole('status').textContent).toBe('We emailed a code to a***@e***. It works for 3 minutes.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' }).disabled).toBe(true);
    await user.type(screen.getByLabelText('Code'), '1234 5678{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/isn't right/));
    await user.clear(screen.getByLabelText('Code'));
    await user.type(screen.getByLabelText('Code'), '87654321{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '87654321' });

    await heading('Finish setting up your account');
    await user.click(screen.getByRole('button', { name: 'Save a passkey' }));
    expect(auth.associateWebAuthnCredential).toHaveBeenCalled();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
  });

  it('joining with a password: at least 15 characters, then the authenticator is required', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' }));
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({}, [{ configured: ['EMAIL_OTP'], mfa: [] }, DONE_FACTORS]);
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
    await heading('Check your email');
    await user.type(screen.getByLabelText('Code'), '12345678{Enter}');

    await heading('Finish setting up your account');
    await user.click(screen.getByRole('button', { name: 'Set a password instead' }));
    await heading('Set a password');
    const field = screen.getByLabelText('New password');
    expect(field.getAttribute('autocomplete')).toBe('new-password');
    expect(field.hasAttribute('maxlength')).toBe(false);
    await user.click(field);
    await user.paste('pasted-from-a-password-manager');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    await waitFor(() => expect(changePasswordWithoutPrevious).toHaveBeenCalledWith('pasted-from-a-password-manager'));

    await heading('Set up your authenticator');
    expect(screen.queryByRole('button', { name: /Not now|Cancel/ })).toBeNull();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(auth.verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456' }));
    expect(auth.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('"Not now" on the first-credential screen continues into the site', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' }));
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({}, [{ configured: ['EMAIL_OTP'], mfa: [] }]);
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
    await user.type(await screen.findByLabelText('Code'), '12345678{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(navigate).toHaveBeenCalled();
  });
});

describe('after sign-in', () => {
  it('a password user without an authenticator gets only the setup screen', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ passkeysEnabled: false }, [{ configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] }, { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }]);
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'my long password{Enter}');
    await heading('Set up your authenticator');
    expect(navigate).not.toHaveBeenCalled();
    const link = await screen.findByRole('link', { name: 'Open the setup link' });
    expect(link.getAttribute('href')).toBe(`otpauth://totp/Example%20Reports:ada%40example.org?secret=${TEST_SECRET}&issuer=Example%20Reports`);
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('offers a passkey once; "Not now" is remembered on this device', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const passwordOnly = { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] };
    let { user, navigate } = setup({}, [passwordOnly]);
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await heading('Save a passkey?');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(navigate).toHaveBeenCalled();
    cleanup();

    ({ user, navigate } = setup({}, [passwordOnly]));
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Save a passkey?' })).toBeNull();
  });

  it('goes on when the factor check fails (the server enforces the authenticator rule anyway)', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(createElement(SignIn, { siteName: 'X', passkeysEnabled: true, navigate, loadFactors: () => Promise.reject(awsError('NetworkError')) }));
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });
});

describe('admin-created accounts (temporary password)', () => {
  it('NEW_PASSWORD_REQUIRED, then MFA_SETUP with the key Cognito issued', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: [] }));
    auth.confirmSignIn
      .mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails: { sharedSecret: TEST_SECRET } }))
      .mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({ passkeysEnabled: false, emailCodeEnabled: false });
    await user.type(screen.getByLabelText('Email address'), 'admin@example.org');
    await user.type(screen.getByLabelText('Password'), 'Temp-123{Enter}');

    await heading('Choose a new password');
    await user.type(screen.getByLabelText('New password'), 'short{Enter}');
    expect(alert().textContent).toMatch(/at least 15/);
    expect(auth.confirmSignIn).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New password'), ' and now long enough{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'short and now long enough' });

    await heading('Set up your authenticator');
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(auth.setUpTOTP).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '123456' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('rejects a breached new password before sending it', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' }));
    const check = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user } = setup({ passkeysEnabled: false, checkBreachedPassword: check });
    await user.type(screen.getByLabelText('Email address'), 'admin@example.org');
    await user.type(screen.getByLabelText('Password'), 'Temp-123{Enter}');
    await user.type(await screen.findByLabelText('New password'), 'password123456789{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/data breach/));
    expect(auth.confirmSignIn).not.toHaveBeenCalled();
  });

  it('refuses a temporary-password account with missing attributes, plainly', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: ['name'] }));
    const { user } = setup({ passkeysEnabled: false });
    await user.type(screen.getByLabelText('Email address'), 'admin@example.org');
    await user.type(screen.getByLabelText('Password'), 'Temp-123{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/missing details/));
  });
});

describe('unsupported steps and step-up', () => {
  it('names an unsupported step plainly', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' }));
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.org{Enter}');
    await waitFor(() => expect(alert().textContent).toMatch(/doesn't support/));
  });

  it('reauth: says why, prefills the email, and replaces the existing session', async () => {
    auth.signIn.mockRejectedValueOnce(awsError('UserAlreadyAuthenticatedException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({ reauth: true });
    expect(screen.getByRole('heading', { name: 'Confirm it’s you' })).toBeTruthy();
    expect(screen.getByText(/sign in again to continue/)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Email address').value).toBe('ada@example.org'));
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(auth.signOut).toHaveBeenCalledWith();
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });
});

describe('styling hooks', () => {
  it('exposes data-auth-kit slots and className / classNames props', () => {
    const { container } = render(
      createElement(SignIn, { siteName: 'X', passkeysEnabled: true, className: 'site-signin', classNames: { button: 'btn', input: 'field-input' } }),
    );
    const root = container.querySelector('[data-auth-kit="sign-in"]')!;
    expect(root.className).toBe('site-signin');
    expect(root.getAttribute('data-auth-kit-view')).toBe('start');
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' }).className).toBe('btn');
    expect(screen.getByLabelText('Email address').className).toBe('field-input');
    expect(container.querySelector('[data-auth-kit-slot="linkButton"]')).not.toBeNull();
  });
});
