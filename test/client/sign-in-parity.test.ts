// @vitest-environment jsdom
/**
 * ADR 0018: until someone proves a factor, the sign-in screens are the same for every address.
 *
 * Each "account" below answers Amplify the way Cognito answers for it, per AWS's documentation and
 * the 2026-10-17 demo deploy (an unknown address under PreventUserExistenceErrors got SELECT_CHALLENGE
 * with [PASSWORD_SRP, PASSWORD, WEB_AUTHN] and, asked for a passkey, a challenge with decoy credential
 * IDs; AWS documents a random selection from the pool's allowed challenge types, so an unknown address
 * might instead get a fake emailed-code challenge, covered as its own case). Someone who can't
 * complete any factor runs the same script against each, and every screen they see must be identical.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignIn, describeAuthError, isFirstFactorUnavailable, type SignInStep } from '../../src/client/index.js';
import { answerSimulatedCode } from '../../src/client/parity.js';
import { auth, awsError, next, resetAmplifyMocks } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const EMAIL = 'someone@example.org';
const choice = (...availableChallenges: string[]) => next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges });
const codeSent = next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 's***@e***', deliveryMedium: 'EMAIL' } });
const closedPrompt = () => awsError('PasskeyAuthenticationCanceled', 'Passkey authentication has been canceled.');
const wrongPassword = () => awsError('NotAuthorizedException', 'Incorrect username or password.');

type Preferred = 'WEB_AUTHN' | 'PASSWORD' | 'EMAIL_OTP';
/** How Cognito (through Amplify) answers a first-factor request for one kind of address. */
type Account = Record<Preferred, () => Promise<unknown>>;

const ACCOUNTS: Record<string, Account> = {
  // No account: a passkey challenge with decoy IDs (the person closes the prompt), the generic password error,
  // and for an emailed code the observed choice without EMAIL_OTP...
  'unknown address (choice without EMAIL_OTP)': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(choice('PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN')),
  },
  // ...or, since AWS documents a random selection, a fake emailed-code challenge.
  'unknown address (fake emailed-code challenge)': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(codeSent),
  },
  // An invite nobody has used: no passkey, no password, no authenticator. Only emailed codes.
  'invited account (emailed code only)': {
    WEB_AUTHN: () => Promise.resolve(choice('EMAIL_OTP')),
    PASSWORD: () => Promise.resolve(choice('EMAIL_OTP')),
    EMAIL_OTP: () => Promise.resolve(codeSent),
  },
  // Password + authenticator: Cognito offers no emailed codes to someone with TOTP turned on.
  'password + authenticator account': {
    WEB_AUTHN: () => Promise.resolve(choice('PASSWORD', 'PASSWORD_SRP')),
    PASSWORD: () => Promise.reject(wrongPassword()),
    EMAIL_OTP: () => Promise.resolve(choice('PASSWORD', 'PASSWORD_SRP')),
  },
  // Passkey only (no authenticator): the real prompt (someone else's passkey isn't on this device), codes allowed.
  'passkey account': {
    WEB_AUTHN: () => Promise.reject(closedPrompt()),
    PASSWORD: () => Promise.resolve(choice('WEB_AUTHN', 'EMAIL_OTP')),
    EMAIL_OTP: () => Promise.resolve(codeSent),
  },
};

function answerAs(account: Account) {
  auth.signIn.mockImplementation((input: { options: { preferredChallenge: Preferred } }) => account[input.options.preferredChallenge]());
  // A code typed into a real emailed-code challenge is wrong (the person doesn't have the inbox).
  auth.confirmSignIn.mockRejectedValue(awsError('CodeMismatchException', 'Invalid code received for user'));
}

/** Everything the person can perceive: the view, every visible text, the fields, and the buttons' states. */
function snapshot(): string {
  const root = document.querySelector('[data-auth-kit="sign-in"]')!;
  const buttons = [...root.querySelectorAll('button')].map((b) => `${b.textContent}${b.disabled ? ' (disabled)' : ''}`);
  const fields = [...root.querySelectorAll('input')].map((i) => `${i.name}=${i.value}${i.getAttribute('aria-invalid') === 'true' ? ' (invalid)' : ''}`);
  return JSON.stringify({ view: root.getAttribute('data-auth-kit-view'), text: root.textContent, buttons, fields }, null, 1);
}

/** What the browser's own passkey sheet did: every path that shows a prompt shows one. */
let promptShown = 0;

beforeEach(() => {
  resetAmplifyMocks();
  promptShown = 0;
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
  for (const [target, key] of [[window, 'isSecureContext'], [window, 'PublicKeyCredential'], [navigator, 'credentials']] as const) {
    Reflect.deleteProperty(target, key);
  }
});

function renderSignIn() {
  render(createElement(SignIn, { siteName: 'Example Reports', passkeysEnabled: true, navigate: vi.fn(), loadFactors: vi.fn(), checkBreachedPassword: false }));
  return userEvent.setup();
}

async function settled(): Promise<string> {
  // Wait out the busy state (every path ends in an announced status or error).
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull(), { timeout: 3000 });
  return snapshot();
}

const SCRIPTS: Record<string, (user: ReturnType<typeof userEvent.setup>, frames: string[]) => Promise<void>> = {
  'Sign in with a passkey': async (user, frames) => {
    await user.type(screen.getByLabelText('Email address'), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).not.toBe(''), { timeout: 3000 });
    frames.push(await settled());
  },
  'Use a password': async (user, frames) => {
    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
    frames.push(snapshot());
    await user.type(screen.getByLabelText('Email address'), EMAIL);
    await user.type(screen.getByLabelText('Password'), 'a guessed password{Enter}');
    await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).not.toBe(''), { timeout: 3000 });
    frames.push(await settled());
  },
  'Email me a code, then guess it twice': async (user, frames) => {
    await user.type(screen.getByLabelText('Email address'), EMAIL);
    await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
    await screen.findByRole('heading', { name: 'Check your email' });
    frames.push(await settled());
    for (const guess of ['12345678', '87654321']) {
      await user.clear(screen.getByLabelText('Code'));
      await user.type(screen.getByLabelText('Code'), `${guess}{Enter}`);
      await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/isn't right/), { timeout: 3000 });
      frames.push(await settled());
    }
    await user.click(screen.getByRole('button', { name: 'Use another way to sign in' }));
    frames.push(snapshot());
  },
};

describe('the same screens for every address (ADR 0018)', () => {
  for (const [scriptName, script] of Object.entries(SCRIPTS)) {
    it(`${scriptName}: identical for an unknown address and every kind of account`, async () => {
      const seen: [string, string[]][] = [];
      for (const [name, account] of Object.entries(ACCOUNTS)) {
        answerAs(account);
        const frames: string[] = [];
        await script(renderSignIn(), frames);
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
    await SCRIPTS['Email me a code, then guess it twice']!(renderSignIn(), frames);
    const first = JSON.parse(frames[0]!) as { text: string };
    expect(first.text).toContain(`If ${EMAIL} has an account here, we've emailed it an 8-digit code. It works for 3 minutes.`);
    expect(first.text).toContain("Accounts with an authenticator app can't get emailed codes: use your password or passkey instead.");
    expect(first.text).not.toContain('s***@e***');
  });

  it('every passkey path shows the browser a passkey prompt', async () => {
    for (const [name, account] of Object.entries(ACCOUNTS)) {
      answerAs(account);
      promptShown = 0;
      const user = renderSignIn();
      await user.type(screen.getByLabelText('Email address'), EMAIL);
      await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
      await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/passkey prompt closed/), { timeout: 3000 });
      // Either Cognito sent a challenge (Amplify prompted: the mocked rejection stands for it) or the decoy did.
      const cognitoPrompted = await account.WEB_AUTHN().then(() => false, () => true);
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

  it('a simulated code expires with the 3-minute session, like a real one', async () => {
    const sentAt = 1_000_000;
    const sleep = () => Promise.resolve();
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + 60_000, sleep })).rejects.toMatchObject({ name: 'CodeMismatchException' });
    await expect(answerSimulatedCode(sentAt, { now: () => sentAt + 3 * 60_000 + 1, sleep })).rejects.toMatchObject({
      name: 'NotAuthorizedException',
      message: expect.stringMatching(/session is expired/),
    });
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

  it('the factor’s own challenge, or the steps after it was proven, go ahead', () => {
    expect(isFirstFactorUnavailable('email-code', steps.code!)).toBe(false);
    expect(isFirstFactorUnavailable('password', steps.password!)).toBe(false);
    for (const method of ['passkey', 'password', 'email-code'] as const) {
      expect(isFirstFactorUnavailable(method, steps.done!)).toBe(false);
      expect(isFirstFactorUnavailable(method, steps.totp!)).toBe(false);
    }
  });
});
