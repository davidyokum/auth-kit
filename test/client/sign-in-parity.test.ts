// @vitest-environment jsdom
/**
 * ADR 0018: until someone proves a factor, the sign-in screens are the same for every address.
 *
 * Each "account" below answers Amplify the way Cognito answers for it, per AWS's documentation and
 * the 2026-10-17 demo deploy (an unknown address under PreventUserExistenceErrors got SELECT_CHALLENGE
 * with [PASSWORD_SRP, PASSWORD, WEB_AUTHN] and, asked for a passkey, a challenge with decoy credential
 * IDs; AWS documents a random selection from the pool's allowed challenge types, so an unknown address
 * might instead get a fake emailed-code challenge, covered as its own case). Accounts Cognito refuses
 * outright are here too: a disabled account and an expired invite (the 7-day sweep disables it) get
 * "User is disabled." for every factor, and a RESET_REQUIRED account gets a password-reset demand.
 * Someone who can't complete any factor runs the same script against each, and every screen they see
 * must be identical: email first, then the passkey screen, the password screen, "Check your email",
 * "Forgot your password?", the help screens' own actions, and SignUp's "Check your email".
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignIn, type SignInProps, SignUp, describeAuthError, isFirstFactorRefusal, isFirstFactorUnavailable, type SignInStep } from '../../src/client/index.js';
import { answerSimulatedCode } from '../../src/client/parity.js';
import { auth, awsError, next, resetAmplifyMocks } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const EMAIL = 'someone@example.org';
const choice = (...availableChallenges: string[]) => next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges });
const codeSent = next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 's***@e***', deliveryMedium: 'EMAIL' } });
const resetCodeSent = (destination: string) =>
  Promise.resolve({ isPasswordReset: false, nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE', codeDeliveryDetails: { destination, deliveryMedium: 'EMAIL' } } });
const closedPrompt = () => awsError('PasskeyAuthenticationCanceled', 'Passkey authentication has been canceled.');
const wrongPassword = () => awsError('NotAuthorizedException', 'Incorrect username or password.');
const userDisabled = () => awsError('NotAuthorizedException', 'User is disabled.');
const resetRequiredStep = next({ signInStep: 'RESET_PASSWORD' });
const resetRequired = () => awsError('PasswordResetRequiredException', 'Password reset required for the user');

const PASSKEY_NOTE = 'We didn’t get a passkey. Try again, or use another way below.';
const WRONG_PASSWORD = 'That email address and password don’t match. Try again, or use another way to sign in.';
const WRONG_EMAILED_CODE = 'That code didn’t work. Check it against the newest email from Example Reports.';
const WRONG_RESET_CODE = 'That code didn’t work. Check it and try again.';

type Preferred = 'WEB_AUTHN' | 'PASSWORD' | 'EMAIL_OTP';
/** How Cognito (through Amplify) answers a first-factor request, and "Forgot your password?", for one kind of address. */
type Account = Record<Preferred | 'RESET', () => Promise<unknown>>;

const ACCOUNTS: Record<string, Account> = {
  // No account: a passkey challenge with decoy IDs (the person closes the prompt), the generic password error,
  // for an emailed code the observed choice without EMAIL_OTP, and a simulated reset-code delivery...
  'unknown address (choice without EMAIL_OTP)': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(choice('PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN')),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // ...or, since AWS documents a random selection, a fake emailed-code challenge (and a pool that says "no such user" to a reset).
  'unknown address (fake emailed-code challenge)': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(codeSent),
    RESET: () => Promise.reject(awsError('UserNotFoundException', 'Username/client id combination not found.')),
  },
  // An invite nobody has used: no passkey, no password, no authenticator. Only emailed codes.
  'invited account (emailed code only)': {
    WEB_AUTHN: () => Promise.resolve(choice('EMAIL_OTP')),
    PASSWORD: () => Promise.resolve(choice('EMAIL_OTP')),
    EMAIL_OTP: () => Promise.resolve(codeSent),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // Password + authenticator: Cognito offers no emailed codes to someone with TOTP turned on.
  'password + authenticator account': {
    WEB_AUTHN: () => Promise.resolve(choice('PASSWORD', 'PASSWORD_SRP')),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(choice('PASSWORD', 'PASSWORD_SRP')),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // Passkey only (no authenticator): the real prompt (someone else's passkey isn't on this device), codes allowed.
  'passkey account': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.resolve(choice('WEB_AUTHN', 'EMAIL_OTP')),
    EMAIL_OTP: () => Promise.resolve(codeSent),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // A disabled account (an admin turned it off): Cognito refuses every first factor with "User is disabled."
  // where an unknown address gets a challenge (M3). A reset refused the same way reads as sent (requestPasswordReset).
  'disabled account': {
    WEB_AUTHN: () => Promise.reject(userDisabled()),
    PASSWORD: () => Promise.reject(userDisabled()),
    EMAIL_OTP: () => Promise.reject(userDisabled()),
    RESET: () => Promise.reject(userDisabled()),
  },
  // An invite nobody used: the 7-day sweep disabled it. The same refusals; here the pool masks the reset (AWS docs).
  'expired invite (disabled)': {
    WEB_AUTHN: () => Promise.reject(userDisabled()),
    PASSWORD: () => Promise.reject(userDisabled()),
    EMAIL_OTP: () => Promise.reject(userDisabled()),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // RESET_REQUIRED (a console "reset password"): Cognito answers PasswordResetRequiredException, which Amplify's
  // USER_AUTH flow turns into the RESET_PASSWORD step, whichever factor was asked for (L5)...
  'password must be reset (RESET_REQUIRED)': {
    WEB_AUTHN: () => Promise.resolve(resetRequiredStep),
    PASSWORD: () => Promise.resolve(resetRequiredStep),
    EMAIL_OTP: () => Promise.resolve(resetRequiredStep),
    RESET: () => resetCodeSent('s***@e***'),
  },
  // ...or the exception itself, should an Amplify version pass it through.
  'password must be reset (the exception itself)': {
    WEB_AUTHN: () => Promise.reject(resetRequired()),
    PASSWORD: () => Promise.reject(resetRequired()),
    EMAIL_OTP: () => Promise.reject(resetRequired()),
    RESET: () => resetCodeSent('s***@e***'),
  },
};

function answerAs(account: Account) {
  auth.signIn.mockImplementation((input: { options: { preferredChallenge: Preferred } }) => account[input.options.preferredChallenge]());
  // A code typed into a real emailed-code challenge is wrong (the person doesn't have the inbox).
  auth.confirmSignIn.mockRejectedValue(awsError('CodeMismatchException', 'Invalid code received for user'));
  auth.resetPassword.mockImplementation(() => account.RESET());
  // A guessed reset code is wrong too; Cognito says the same for an unknown address.
  auth.confirmResetPassword.mockRejectedValue(awsError('CodeMismatchException', 'Invalid verification code provided, please try again.'));
}

/** Everything the person can perceive: the view, every visible text, the fields, and the buttons' states. */
function snapshot(card: 'sign-in' | 'sign-up' = 'sign-in'): string {
  const root = document.querySelector(`[data-auth-kit="${card}"]`)!;
  const buttons = [...root.querySelectorAll('button')].map((b) => `${b.textContent}${b.disabled ? ' (disabled)' : ''}`);
  const fields = [...root.querySelectorAll('input')].map((i) => `${i.name}=${i.value}${i.getAttribute('aria-invalid') === 'true' ? ' (invalid)' : ''}`);
  const alert = root.querySelector('[role="alert"]:not([hidden])')?.textContent ?? null;
  return JSON.stringify({ view: root.getAttribute('data-auth-kit-view'), text: root.textContent, alert, buttons, fields }, null, 1);
}

/** What the browser's own passkey sheet did: every path that shows a prompt shows one. */
let promptShown = 0;

// No network from tests: anything that reaches the real fetch (Cognito's endpoint, a route) fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));

beforeEach(() => {
  resetAmplifyMocks();
  promptShown = 0;
  vi.stubGlobal('fetch', noNetwork);
  // A browser with passkeys, where the person closes the sheet (nothing matches): Amplify's real prompt
  // is mocked away with signIn, so count it there; the decoy goes through navigator.credentials.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(window, 'PublicKeyCredential', { value: function PublicKeyCredential() {}, configurable: true });
  Object.defineProperty(navigator, 'credentials', {
    value: {
      get: vi.fn(() => {
        promptShown++;
        return Promise.reject(Object.assign(new Error('Not allowed'), { name: 'NotAllowedError' }));
      }),
    },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
  for (const [target, key] of [[window, 'isSecureContext'], [window, 'PublicKeyCredential'], [navigator, 'credentials']] as const) {
    Reflect.deleteProperty(target, key);
  }
});

function renderSignIn(props: Partial<SignInProps> = {}) {
  render(
    createElement(SignIn, {
      siteName: 'Example Reports',
      help: { address: 'apps-help@example.org' },
      passkeysEnabled: true,
      navigate: vi.fn(),
      loadFactors: vi.fn(),
      checkBreachedPassword: false,
      ...props,
    }),
  );
  return userEvent.setup();
}

async function settled(card: 'sign-in' | 'sign-up' = 'sign-in'): Promise<string> {
  // Wait out the busy state (every path ends in an announced status, note, or error).
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull(), { timeout: 3000 });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })?.hasAttribute('disabled') ?? false).toBe(false), { timeout: 3000 });
  return snapshot(card);
}

const alertSays = (text: string) => waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text), { timeout: 3000 });
const typeEmail = (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('Email address'), EMAIL);

type Script = { props?: Partial<SignInProps>; run: (user: ReturnType<typeof userEvent.setup>, frames: string[]) => Promise<void> };

const SCRIPTS: Record<string, Script> = {
  'Continue (the passkey screen), then Try again': {
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByText(PASSKEY_NOTE, undefined, { timeout: 3000 });
      frames.push(await settled());
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByText(PASSKEY_NOTE, undefined, { timeout: 3000 });
      frames.push(await settled());
    },
  },
  'Use a password instead': {
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
      await screen.findByRole('heading', { name: 'Enter your password' });
      frames.push(snapshot());
      await user.type(screen.getByLabelText('Password'), 'a guessed password{Enter}');
      await alertSays(WRONG_PASSWORD);
      frames.push(await settled());
    },
  },
  'Passkeys off: Continue goes to the password': {
    props: { passkeysEnabled: false },
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByRole('heading', { name: 'Enter your password' });
      frames.push(snapshot());
      await user.type(screen.getByLabelText('Password'), 'a guessed password{Enter}');
      await alertSays(WRONG_PASSWORD);
      frames.push(await settled());
    },
  },
  'Email me a code, then guess it twice': {
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
      await screen.findByRole('heading', { name: 'Check your email' });
      frames.push(await settled());
      for (const guess of ['12345678', '87654321']) {
        await user.clear(screen.getByLabelText('8-digit code'));
        await user.type(screen.getByLabelText('8-digit code'), `${guess}{Enter}`);
        await alertSays(WRONG_EMAILED_CODE);
        frames.push(await settled());
      }
      await user.click(screen.getByRole('button', { name: 'Use a different email address' }));
      frames.push(snapshot());
    },
  },
  'Forgot your password, then guess the reset code': {
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
      await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
      await screen.findByRole('heading', { name: 'Forgot your password?' });
      frames.push(snapshot());
      await user.click(screen.getByRole('button', { name: 'Send a reset code' }));
      await screen.findByRole('heading', { name: 'Check your email' });
      frames.push(await settled());
      await user.type(screen.getByLabelText('Reset code'), '12345678{Enter}');
      await screen.findByRole('heading', { name: 'Choose a new password' });
      frames.push(snapshot());
      await user.type(screen.getByLabelText('New password'), 'a brand new long password{Enter}');
      await alertSays(WRONG_RESET_CODE);
      frames.push(await settled());
    },
  },
  'Trouble signing in, then "Email me a code" on the passkey help': {
    run: async (user, frames) => {
      await typeEmail(user);
      await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
      await screen.findByRole('heading', { name: 'Trouble signing in?' });
      frames.push(snapshot());
      await user.click(screen.getByRole('button', { name: 'I can’t use my passkey' }));
      await screen.findByRole('heading', { name: 'Can’t use your passkey?' });
      frames.push(snapshot());
      await user.click(screen.getByRole('button', { name: 'Email me a code' }));
      await screen.findByRole('heading', { name: 'Check your email' });
      frames.push(await settled());
      await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
      await alertSays(WRONG_EMAILED_CODE);
      frames.push(await settled());
    },
  },
};

describe('the same screens for every address (ADR 0018)', () => {
  for (const [scriptName, script] of Object.entries(SCRIPTS)) {
    it(`${scriptName}: identical for an unknown address and every kind of account`, async () => {
      const seen: [string, string[]][] = [];
      for (const [name, account] of Object.entries(ACCOUNTS)) {
        answerAs(account);
        const frames: string[] = [];
        await script.run(renderSignIn(script.props), frames);
        seen.push([name, frames]);
        cleanup();
      }
      const [[firstName, firstFrames], ...rest] = seen as [[string, string[]], ...[string, string[]][]];
      expect(firstFrames.length).toBeGreaterThan(0);
      for (const [name, frames] of rest) expect(frames, `${name} vs ${firstName}`).toEqual(firstFrames);
    });
  }

  it('what they all see, in words', async () => {
    answerAs(ACCOUNTS['invited account (emailed code only)']!);
    const frames: string[] = [];
    await SCRIPTS['Email me a code, then guess it twice']!.run(renderSignIn(), frames);
    const first = JSON.parse(frames[0]!) as { text: string; alert: string | null };
    expect(first.text).toContain(`If ${EMAIL} has an account here, we’ve emailed it an 8-digit code. It works for 10 minutes.`);
    expect(first.text).toContain('Accounts with an authenticator app can’t get emailed codes. Use your password or passkey instead.');
    expect(first.text).not.toContain('s***@e***');
    expect(first.alert).toBeNull();
    expect((JSON.parse(frames[1]!) as { alert: string }).alert).toBe(WRONG_EMAILED_CODE);
    cleanup();

    answerAs(ACCOUNTS['password + authenticator account']!);
    const passkeyFrames: string[] = [];
    await SCRIPTS['Continue (the passkey screen), then Try again']!.run(renderSignIn(), passkeyFrames);
    const passkey = JSON.parse(passkeyFrames[0]!) as { view: string; text: string; alert: string | null };
    expect(passkey.view).toBe('passkey');
    expect(passkey.text).toContain(`Signing in as ${EMAIL}`);
    expect(passkey.text).toContain(PASSKEY_NOTE);
    // A calm note, not an error: nothing in the error summary.
    expect(passkey.alert).toBeNull();
    cleanup();

    answerAs(ACCOUNTS['invited account (emailed code only)']!);
    const resetFrames: string[] = [];
    await SCRIPTS['Forgot your password, then guess the reset code']!.run(renderSignIn(), resetFrames);
    expect((JSON.parse(resetFrames[1]!) as { text: string }).text).toContain(`If ${EMAIL} has an account here, we’ve emailed it a code to reset your password. It works for 1 hour.`);
  });

  it('every passkey path shows the browser a passkey prompt', async () => {
    for (const [name, account] of Object.entries(ACCOUNTS)) {
      answerAs(account);
      promptShown = 0;
      const user = renderSignIn();
      await user.type(screen.getByLabelText('Email address'), EMAIL);
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByText(PASSKEY_NOTE, undefined, { timeout: 3000 });
      // Either Cognito sent a challenge (Amplify prompted: the mocked closed prompt stands for it) or the decoy did.
      const cognitoPrompted = await account.WEB_AUTHN().then(
        () => false,
        (error: Error) => error.name === 'PasskeyAuthenticationCanceled',
      );
      expect(promptShown + (cognitoPrompted ? 1 : 0), name).toBe(1);
      cleanup();
    }
  });

  it('a wrong emailed code reads the same whichever error Cognito gives (a fake challenge may answer either)', () => {
    const mismatch = describeAuthError(awsError('CodeMismatchException', 'Invalid code received for user'), 'code');
    const notAuthorized = describeAuthError(awsError('NotAuthorizedException', 'Incorrect username or password.'), 'code');
    expect(notAuthorized).toMatchObject({ kind: 'wrong-code', message: mismatch.message });
    expect(describeAuthError(awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.'), 'code').kind).toBe('session-expired');
  });

  it('a simulated code expires with the sign-in session, like a real one (10 minutes, or the site’s lifetime)', async () => {
    const sentAt = 1_000_000;
    const sleep = () => Promise.resolve();
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + 9 * 60_000, sleep })).rejects.toMatchObject({ name: 'CodeMismatchException' });
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + 10 * 60_000 + 1, sleep })).rejects.toMatchObject({
      name: 'NotAuthorizedException',
      message: expect.stringMatching(/session is expired/),
    });
    const threeMinutes = 3 * 60_000;
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + 2 * 60_000, sleep, lifetimeMs: threeMinutes })).rejects.toMatchObject({ name: 'CodeMismatchException' });
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + threeMinutes + 1, sleep, lifetimeMs: threeMinutes })).rejects.toMatchObject({ name: 'NotAuthorizedException' });
  });
});

describe('SignUp’s "Check your email" is the same for every address (ADR 0018)', () => {
  function renderSignUp() {
    // The sign-up route answers the same for every address (ADR 0023): a new account, or an email to the existing one.
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(
      createElement(SignUp, {
        siteName: 'Example Reports',
        help: { address: 'apps-help@example.org' },
        accountCreation: { mode: 'open' },
        privacyNoticeUrl: '/privacy',
        passkeysEnabled: true,
        navigate: vi.fn(),
        loadFactors: vi.fn(),
        fetch,
        checkBreachedPassword: false,
      }),
    );
    return userEvent.setup();
  }

  it('the email, the code screen, two guesses, and "Use a different email address": identical for an unknown address and every kind of account', async () => {
    const seen: [string, string[]][] = [];
    for (const [name, account] of Object.entries(ACCOUNTS)) {
      answerAs(account);
      const user = renderSignUp();
      const frames: string[] = [];
      await user.type(screen.getByLabelText('Email address'), `${EMAIL}{Enter}`);
      await screen.findByRole('heading', { name: 'Check your email' }, { timeout: 3000 });
      frames.push(await settled('sign-up'));
      for (const guess of ['12345678', '87654321']) {
        await user.clear(screen.getByLabelText('8-digit code'));
        await user.type(screen.getByLabelText('8-digit code'), `${guess}{Enter}`);
        await alertSays(WRONG_EMAILED_CODE);
        frames.push(await settled('sign-up'));
      }
      await user.click(screen.getByRole('button', { name: 'Use a different email address' }));
      frames.push(snapshot('sign-up'));
      seen.push([name, frames]);
      cleanup();
    }
    const [[firstName, firstFrames], ...rest] = seen as [[string, string[]], ...[string, string[]][]];
    expect(JSON.parse(firstFrames[0]!).text).toContain(`We’ve emailed ${EMAIL}.`);
    for (const [name, frames] of rest) expect(frames, `${name} vs ${firstName}`).toEqual(firstFrames);
  });
});

describe('isFirstFactorRefusal', () => {
  it('a disabled account (an expired invite too), a password that must be reset, and "no such account" are refusals', () => {
    expect(isFirstFactorRefusal(userDisabled())).toBe(true);
    expect(isFirstFactorRefusal(resetRequired())).toBe(true);
    expect(isFirstFactorRefusal(wrongPassword())).toBe(true);
    expect(isFirstFactorRefusal(awsError('UserNotFoundException', 'User does not exist.'))).toBe(true);
  });

  it('a throttle, an expired session, the network, a closed passkey window, and anything else keep their own messages', () => {
    expect(isFirstFactorRefusal(awsError('NotAuthorizedException', 'Password attempts exceeded'))).toBe(false);
    expect(isFirstFactorRefusal(awsError('NotAuthorizedException', 'Too many failed attempts.'))).toBe(false);
    expect(isFirstFactorRefusal(awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.'))).toBe(false);
    expect(isFirstFactorRefusal(awsError('LimitExceededException', 'Attempt limit exceeded, please try after some time.'))).toBe(false);
    expect(isFirstFactorRefusal(awsError('ForbiddenException', 'Request not allowed due to WAF block.'))).toBe(false);
    expect(isFirstFactorRefusal(new TypeError('Failed to fetch'))).toBe(false);
    expect(isFirstFactorRefusal(closedPrompt())).toBe(false);
    expect(isFirstFactorRefusal('weird')).toBe(false);
  });
});

describe('isFirstFactorUnavailable', () => {
  const steps: Record<string, SignInStep> = {
    choice: { step: 'choose-method', methods: ['email-code'] },
    password: { step: 'password' },
    code: { step: 'email-code', destination: 's***@e***' },
    done: { step: 'done' },
    totp: { step: 'totp' },
  };

  it('a choice of methods, or another factor’s challenge, means "not available to this account"', () => {
    expect(isFirstFactorUnavailable('passkey', steps.choice!)).toBe(true);
    expect(isFirstFactorUnavailable('passkey', steps.code!)).toBe(true);
    expect(isFirstFactorUnavailable('passkey', steps.password!)).toBe(true);
    expect(isFirstFactorUnavailable('password', steps.choice!)).toBe(true);
    expect(isFirstFactorUnavailable('password', steps.code!)).toBe(true);
    expect(isFirstFactorUnavailable('email-code', steps.choice!)).toBe(true);
    expect(isFirstFactorUnavailable('email-code', steps.password!)).toBe(true);
  });

  it('a password that must be reset (RESET_PASSWORD) is "not available" for every factor (an unknown address never gets it)', () => {
    for (const method of ['passkey', 'password', 'email-code'] as const) expect(isFirstFactorUnavailable(method, { step: 'reset-password' })).toBe(true);
  });

  it('the factor’s own challenge, or the steps after it was proven, go ahead', () => {
    expect(isFirstFactorUnavailable('email-code', steps.code!)).toBe(false);
    expect(isFirstFactorUnavailable('password', steps.password!)).toBe(false);
    for (const method of ['passkey', 'password', 'email-code'] as const) {
      expect(isFirstFactorUnavailable(method, steps.done!)).toBe(false);
      expect(isFirstFactorUnavailable(method, steps.totp!)).toBe(false);
    }
  });
});
