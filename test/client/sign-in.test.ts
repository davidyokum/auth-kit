// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { type ClientAuthFactors, SignIn, type SignInProps, authTheme } from '../../src/client/index.js';
import type { ThemeFamily } from '../../src/themes/index.js';
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

const HELP = { address: 'apps-help@example.org' };
const DONE_FACTORS: ClientAuthFactors = { configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] };
const FRESH_INVITE: ClientAuthFactors = { configured: ['EMAIL_OTP'], mfa: [] };
const CODE_SENT = next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } });
const TOTP_STEP = next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' });
const SESSION_EXPIRED = () => awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.');

function setup(props: Partial<SignInProps> = {}, factors: ClientAuthFactors[] = [DONE_FACTORS]) {
  const navigate = vi.fn();
  const queue = [...factors];
  const loadFactors = vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!));
  const user = userEvent.setup();
  render(
    createElement(SignIn, {
      siteName: 'Example Reports',
      help: HELP,
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

type User = ReturnType<typeof userEvent.setup>;

const root = () => document.querySelector<HTMLElement>('[data-auth-kit="sign-in"]')!;
const card = () => root().querySelector<HTMLElement>('[data-backdrop-card]')!;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
/** The error summary (role alert; hidden, so absent from the tree, when there's no error). */
const summary = () => screen.getByRole('alert');
const findSummary = () => screen.findByRole('alert');
/** The error repeated by the field. */
const inlineError = (field: HTMLElement) => document.getElementById(`${field.id}-error`)?.textContent ?? null;
const submitButtons = () => [...root().querySelectorAll('button[type="submit"]')].map((b) => b.textContent);
const slotText = (name: string) => root().querySelector(`[data-auth-kit-slot="${name}"]`)?.textContent ?? null;
const emailField = () => screen.getByLabelText<HTMLInputElement>('Email address');
// Buttons with screen-reader-only words ("Change<span> email address</span>"). Browsers keep the
// span's leading space in the accessible name; jsdom's dom-accessibility-api drops it.
const CHANGE = /^Change ?email address$/;
const SHOW = /^Show ?password$/;
const HIDE = /^Hide ?password$/;

async function enterEmail(user: User, email = 'ada@example.org') {
  await user.type(emailField(), email);
}

/** Email, then "Use a password instead", then the password. */
async function submitPassword(user: User, password = 'my long password') {
  await enterEmail(user);
  await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
  await heading('Enter your password');
  await user.type(screen.getByLabelText('Password'), `${password}{Enter}`);
}

/** Email, then "Email me a code instead". */
async function askForCode(user: User) {
  await enterEmail(user);
  await user.click(screen.getByRole('button', { name: 'Email me a code instead' }));
  await heading('Check your email');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** WebAuthn in jsdom, with a person who closes the browser's passkey prompt. */
function stubPasskeyBrowser() {
  const get = vi.fn((_options: unknown) => Promise.reject(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' })));
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(window, 'PublicKeyCredential', { value: function PublicKeyCredential() {}, configurable: true });
  Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
  return { get };
}

function unstubPasskeyBrowser() {
  for (const [target, key] of [[window, 'isSecureContext'], [window, 'PublicKeyCredential'], [navigator, 'credentials']] as const) {
    if (Object.getOwnPropertyDescriptor(target, key)?.configurable) Reflect.deleteProperty(target, key);
  }
}

// No network from tests: anything that reaches the real fetch (Cognito's endpoint, a route) fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));

beforeEach(() => {
  resetAmplifyMocks();
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  cleanup();
  unstubPasskeyBrowser();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
});

describe('the email step', () => {
  it('asks for the email first, with Continue, and marks the field for password managers', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Sign in to Example Reports', level: 1 })).toBeTruthy();
    expect(root().getAttribute('data-auth-kit-view')).toBe('email');
    const email = emailField();
    expect(email.getAttribute('autocomplete')).toBe('username webauthn');
    expect(email.getAttribute('type')).toBe('email');
    expect(submitButtons()).toEqual(['Continue']);
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a code instead' })).toBeTruthy();
    // Email first: no password field and no passkey call until Continue.
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('Continue opens the passkey screen: who, the wait, a secondary Try again, and no final button', async () => {
    auth.signIn.mockReturnValue(new Promise(() => undefined));
    const { user } = setup();
    await user.type(emailField(), ' ada@example.org {Enter}');
    await heading('Use your passkey');
    expect(root().getAttribute('data-auth-kit-view')).toBe('passkey');
    expect(auth.signIn).toHaveBeenCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } });
    expect(screen.getByText('Confirm with your face, fingerprint, or device PIN when your browser asks.')).toBeTruthy();
    expect(slotText('who')).toBe('Signing in as ada@example.org · Change email address');
    expect(screen.getByText('Waiting for your passkey…').closest('[role="status"]')).not.toBeNull();
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgain.getAttribute('type')).toBe('button');
    expect(tryAgain.getAttribute('data-auth-kit-slot')).toBe('secondaryButton');
    // The browser's own window finishes the step: there's nothing to submit.
    expect(submitButtons()).toEqual([]);
    expect(screen.getByText('Passkey on your phone? Choose the phone option in the window that opens.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a code instead' })).toBeTruthy();
  });

  it('with passkeys off, Continue opens "Enter your password", and emailed codes hide when the pool has none', async () => {
    const { user } = setup({ passkeysEnabled: false, emailCodeEnabled: false });
    expect(screen.queryByRole('button', { name: /passkey|password instead/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Email me a code/ })).toBeNull();
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(slotText('who')).toBe('for ada@example.org · Change email address');
    const password = screen.getByLabelText('Password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(password.getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: SHOW }));
    expect(password.getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: HIDE }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Forgot your password?' })).toBeTruthy();
    expect(submitButtons()).toEqual(['Continue']);
    expect(screen.queryByRole('button', { name: /passkey|Email me a code/i })).toBeNull();
  });

  it('"Change" on the password and passkey screens goes back to the email, kept', async () => {
    auth.signIn.mockReturnValue(new Promise(() => undefined));
    const { user } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    await user.click(screen.getByRole('button', { name: CHANGE }));
    await heading('Sign in to Example Reports');
    expect(emailField().value).toBe('ada@example.org');
    expect(screen.queryByLabelText('Password')).toBeNull();
    cleanup();

    // On the passkey screen, after the browser's window closed (while it's open, the screen is busy).
    auth.signIn.mockRejectedValue(awsError('PasskeyAuthenticationCanceled'));
    const second = setup({ emailCodeEnabled: false });
    await second.user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Use your passkey');
    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    expect(screen.queryByRole('button', { name: 'Email me a code instead' })).toBeNull();
    await second.user.click(screen.getByRole('button', { name: CHANGE }));
    await heading('Sign in to Example Reports');
    expect(emailField().value).toBe('ada@example.org');
  });

  it('asks for an email before calling Cognito: a summary that takes focus and links to the field, and the error by the field', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = summary();
    expect(alert.textContent).toBe('Enter your email address');
    expect(document.activeElement).toBe(alert);
    const email = emailField();
    const link = within(alert).getByRole('link', { name: 'Enter your email address' });
    expect(link.getAttribute('href')).toBe(`#${email.id}`);
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toContain(`${email.id}-error`);
    expect(inlineError(email)).toBe('Error: Enter your email address');
    expect(auth.signIn).not.toHaveBeenCalled();
    await user.click(link);
    expect(document.activeElement).toBe(email);

    await user.type(email, 'ada{Enter}');
    expect(summary().textContent).toBe('Enter an email address like name@example.com');
    expect(inlineError(email)).toBe('Error: Enter an email address like name@example.com');
    // "Use a password instead" needs the address too.
    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('the email hint comes from the theme, and a site’s own hint wins', () => {
    const cases: [Partial<SignInProps>, string][] = [
      [{}, 'name@example.com'],
      [{ theme: 'personal' }, 'name@example.com'],
      [{ theme: 'osbm' }, 'name@osbm.nc.gov'],
      [{ theme: 'unc' }, 'name@unc.edu'],
      [{ theme: 'osbm', emailHint: '  name@nc.gov ' }, 'name@nc.gov'],
      [{ theme: authTheme('osbm', { emailHint: 'name@nc.gov' }) }, 'name@nc.gov'],
      [{ theme: 'unc', emailHint: '   ' }, 'name@unc.edu'],
    ];
    for (const [props, hint] of cases) {
      setup(props);
      expect(emailField().getAttribute('placeholder'), JSON.stringify(props)).toBe(hint);
      // The label stays a real, visible <label>: the hint never replaces it.
      expect(document.querySelector('label[for]')?.textContent).toBe('Email address');
      cleanup();
    }
  });

  it('the email field carries an envelope icon, hidden from screen readers (register A9)', () => {
    setup();
    const wrap = emailField().parentElement!;
    expect(wrap.getAttribute('data-auth-kit-slot')).toBe('inputWrap');
    const icon = wrap.querySelector('svg[data-auth-kit-icon="mail"]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(emailField().hasAttribute('data-auth-kit-has-icon')).toBe(true);
  });

  it('the hint shows on every email field, and the format error names it', async () => {
    const { user } = setup({ theme: 'osbm' });
    await user.type(emailField(), 'ada{Enter}');
    expect(summary().textContent).toBe('Enter an email address like name@osbm.nc.gov');
    await user.clear(emailField());
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await user.click(screen.getByRole('button', { name: 'I forgot my password' }));
    expect(emailField().getAttribute('placeholder')).toBe('name@osbm.nc.gov');
  });
});

describe('the card', () => {
  it('is marked for the backdrop, themed, and carries the family', () => {
    setup({ theme: 'osbm' });
    expect(root().getAttribute('data-auth-kit-family')).toBe('osbm');
    expect(card().getAttribute('data-auth-kit-slot')).toBe('card');
    expect(card().style.getPropertyValue('--ak-surface')).toBe('#ffffff');
    expect(card().style.getPropertyValue('--ak-edge')).toMatch(/^#[0-9a-f]{6}$/);
    expect(card().contains(screen.getByRole('heading', { name: 'Sign in to Example Reports' }))).toBe(true);
  });

  it('invite-only by default: the "Need access?" link opens who to ask', async () => {
    const { user } = setup();
    expect(slotText('access')).toBe('New to Example Reports? It’s invite-only. Need access?');
    await user.click(screen.getByRole('button', { name: 'Need access?' }));
    await heading('Need access to Example Reports?');
    expect(screen.getByText('Example Reports is invite-only. The Example Reports team adds people and sends each one an email invitation.')).toBeTruthy();
    expect(screen.getByText('Already invited? Find the email from Example Reports, then sign in with the address it was sent to.')).toBeTruthy();
    const contact = root().querySelector('[data-auth-kit-slot="contact"]')!;
    expect([...contact.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Ask for an invitation', 'Email apps-help@example.org.', 'Never send a password or code.']);
    expect(within(contact as HTMLElement).getByRole('link', { name: 'apps-help@example.org' }).getAttribute('href')).toBe('mailto:apps-help@example.org');
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await heading('Sign in to Example Reports');
  });

  it('a named family names the owner on "Need access?"', async () => {
    const { user } = setup({ theme: 'osbm', help: { address: 'apps-help@example.org', owner: 'Jordan Lee' } });
    await user.click(screen.getByRole('button', { name: 'Need access?' }));
    await heading('Need access to Example Reports?');
    expect(screen.getByText('Example Reports is invite-only. Jordan Lee adds people and sends each one an email invitation.')).toBeTruthy();
    expect(slotText('contact')).toContain('Email apps-help@example.org. Jordan Lee looks after Example Reports.');
  });

  it('the four access lines', () => {
    setup({ inviteLine: 'sentence' });
    expect(slotText('access')).toBe('New to Example Reports? It’s invite-only. Ask the person who runs it to add you.');
    expect(screen.queryByRole('button', { name: 'Need access?' })).toBeNull();
    cleanup();

    setup({ accountCreation: { mode: 'request' } });
    expect(slotText('access')).toBe('Need access? Request it.');
    expect(screen.getByRole('link', { name: 'Need access? Request it.' }).getAttribute('href')).toBe('/request-access');
    cleanup();
    setup({ accountCreation: { mode: 'request' }, requestAccessHref: '/ask-for-access' });
    expect(screen.getByRole('link', { name: 'Need access? Request it.' }).getAttribute('href')).toBe('/ask-for-access');
    cleanup();

    for (const accountCreation of [{ mode: 'domains', domains: ['example.org'] }, { mode: 'open' }] as const) {
      setup({ accountCreation });
      expect(slotText('access')).toBe('New here? Create an account');
      expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/sign-up');
      cleanup();
      setup({ accountCreation, signUpHref: '/join' });
      expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/join');
      cleanup();
    }
  });

  it('the access line is only on the email step, and not when confirming it’s you', async () => {
    const { user } = setup({ passkeysEnabled: false });
    expect(slotText('access')).not.toBeNull();
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    expect(slotText('access')).toBeNull();
    cleanup();
    setup({ reauth: true });
    expect(slotText('access')).toBeNull();
  });

  it('the family’s identity line is at the foot of the card (OSBM, UNC), and personal sites have none', async () => {
    const { user } = setup({ theme: 'osbm', passkeysEnabled: false });
    expect(slotText('footer')).toBe('This site is managed by the NC Office of State Budget and Management');
    expect(card().querySelector('[data-auth-kit-slot="bottom"]')!.lastElementChild!.getAttribute('data-auth-kit-slot')).toBe('footer');
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    expect(slotText('footer')).toBe('This site is managed by the NC Office of State Budget and Management');
    cleanup();
    setup({ theme: 'unc' });
    expect(slotText('footer')).toBe('This site is managed by UNC-Chapel Hill');
    cleanup();
    setup({ theme: 'personal' });
    expect(slotText('footer')).toBeNull();
    cleanup();
    setup();
    expect(slotText('footer')).toBeNull();
  });

  it('shows the authorized-use line only when the theme turns it on', () => {
    setup({ theme: 'osbm' });
    expect(slotText('notice')).toBeNull();
    cleanup();
    setup({ theme: authTheme('osbm', { showAuthorizedUse: true }) });
    expect(slotText('notice')).toBe('This is a State of North Carolina system for authorized use.');
  });

  it('"Trouble signing in?" sits inside the card by default, and just below it with troubleLink "below"', () => {
    setup();
    let trouble = screen.getByRole('button', { name: 'Trouble signing in?' });
    expect(card().contains(trouble)).toBe(true);
    expect(root().querySelector('[data-auth-kit-slot="below"]')).toBeNull();
    cleanup();

    setup({ troubleLink: 'below' });
    const all = screen.getAllByRole('button', { name: 'Trouble signing in?' });
    expect(all).toHaveLength(1);
    trouble = all[0]!;
    expect(card().contains(trouble)).toBe(false);
    expect(root().contains(trouble)).toBe(true);
    expect(trouble.closest('[data-auth-kit-slot="below"]')).not.toBeNull();
  });

  it('"Trouble signing in?" is on the sign-in steps, not on the help screens', async () => {
    const { user } = setup({ passkeysEnabled: false, troubleLink: 'below' });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    expect(screen.getByRole('button', { name: 'Trouble signing in?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await heading('Trouble signing in?');
    expect(screen.queryByRole('button', { name: 'Trouble signing in?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Something else' }));
    await heading('Something else?');
    expect(screen.queryByRole('button', { name: 'Trouble signing in?' })).toBeNull();
  });
});

describe('trouble signing in', () => {
  const ROWS = ['I can’t use my passkey', 'I forgot my password', 'I lost my authenticator app', 'I didn’t get a code', 'I can’t get into my email', 'Something else'];
  const HEADINGS = ['Can’t use your passkey?', 'Forgot your password?', 'Lost your authenticator app?', 'Didn’t get a code?', 'Can’t get into your email?', 'Something else?'];

  it('the triage list has six rows; "Back to sign in" returns', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await heading('Trouble signing in?');
    expect(root().getAttribute('data-auth-kit-view')).toBe('trouble');
    expect(screen.getByText('Choose what’s happening and we’ll show you what to do.')).toBeTruthy();
    const list = root().querySelector('[data-auth-kit-slot="list"]')!;
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(ROWS);
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await heading('Sign in to Example Reports');
  });

  const FAMILIES: [ThemeFamily, { team: string; Team: string; verify: string; itDesk: string; owner: boolean }][] = [
    ['personal', { team: 'the Example Reports team', Team: 'The Example Reports team', verify: 'by email', itDesk: 'your email provider, or your IT help desk if your organization runs your email', owner: false }],
    ['osbm', { team: 'Jordan Lee', Team: 'Jordan Lee', verify: 'on Teams or by phone', itDesk: 'your agency’s IT help desk', owner: true }],
    ['unc', { team: 'Jordan Lee', Team: 'Jordan Lee', verify: 'by phone or in person', itDesk: 'the UNC IT help desk', owner: true }],
  ];

  for (const [family, words] of FAMILIES) {
    it(`each of the six help screens, with its contact box (${family})`, async () => {
      const { user } = setup({ theme: family, help: { address: 'apps-help@example.org', owner: 'Jordan Lee' } });
      await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
      for (const [i, row] of ROWS.entries()) {
        await user.click(await screen.findByRole('button', { name: row }));
        await heading(HEADINGS[i]!);
        expect(root().getAttribute('data-auth-kit-view')).toBe('help');
        const contact = root().querySelector('[data-auth-kit-slot="contact"]')!;
        const lines = [...contact.querySelectorAll('p')].map((p) => p.textContent);
        expect(lines[0]).toBe('Need help with your Example Reports account? Email apps-help@example.org.');
        expect(within(contact as HTMLElement).getByRole('link', { name: 'apps-help@example.org' }).getAttribute('href')).toBe('mailto:apps-help@example.org');
        expect(lines.includes('Jordan Lee looks after Example Reports.'), `${family} ${row}`).toBe(words.owner);
        expect(lines.includes('Not sure an email is really from us? Ask Jordan Lee on Teams.')).toBe(family === 'osbm' && row === 'Something else');
        expect(lines.at(-1)).toBe('Never send a password or code.');
        const text = card().textContent;
        if (row === 'I lost my authenticator app') {
          expect(text).toContain(`so ${words.team} has to reset it on your Example Reports account.`);
          expect(text).toContain(`${words.Team} will confirm it’s you ${words.verify}, then reset it on your account.`);
          expect(text).toContain(`Email apps-help@example.org from the address you sign in with`);
        }
        if (row === 'I can’t get into my email') {
          expect(text).toContain(`We can’t help you get back into your email. For that, contact ${words.itDesk}.`);
          expect(text).toContain(`After confirming it’s you, ${words.team} will move your account to it.`);
        }
        if (row === 'I didn’t get a code') {
          expect(text.includes('State email screens messages, which can add a short delay.')).toBe(family === 'osbm');
          expect(text.includes('If it’s held in quarantine,')).toBe(family !== 'personal');
        }
        await user.click(screen.getByRole('button', { name: 'Back' }));
        await heading('Trouble signing in?');
      }
    });
  }

  it('without an owner, a named family says "the {Site} team" too', async () => {
    const { user } = setup({ theme: 'osbm' });
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await user.click(screen.getByRole('button', { name: 'I lost my authenticator app' }));
    await heading('Lost your authenticator app?');
    expect(card().textContent).toContain('so the Example Reports team has to reset it');
    expect(slotText('contact')).not.toContain('looks after');
  });

  it('a help screen’s action asks for the address when it wasn’t typed yet', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await user.click(screen.getByRole('button', { name: 'I forgot my password' }));
    await heading('Forgot your password?');
    expect(screen.getByText('We’ll email you a code so you can choose a new one.')).toBeTruthy();
    // Said only where the site sends the notice.
    expect(screen.queryByText('We’ll email you a note when your password changes.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send a reset code' }));
    expect(summary().textContent).toBe('Enter your email address');
    await heading('Forgot your password?');
    expect(auth.resetPassword).not.toHaveBeenCalled();
    // The field stays while the address is typed (it once vanished as soon as the text looked like one).
    await user.type(emailField(), 'ada@example.org');
    expect(emailField().value).toBe('ada@example.org');
    expect(document.activeElement).toBe(emailField());
    await user.keyboard('{Enter}');
    await heading('Check your email');
    expect(auth.resetPassword).toHaveBeenCalledWith({ username: 'ada@example.org' });
  });

  it('the help screens’ buttons: an emailed code (only where the pool has them) and a new code', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    const { user } = setup({ codeLifetimeMinutes: 10, securityNotices: true });
    await enterEmail(user);
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await user.click(screen.getByRole('button', { name: 'I forgot my password' }));
    expect(await screen.findByText('We’ll email you a note when your password changes.')).toBeTruthy();
    // The address was typed already, so the button doesn't ask again.
    expect(screen.queryByLabelText('Email address')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'I didn’t get a code' }));
    await heading('Didn’t get a code?');
    expect(screen.getByText('Send a new code and use the newest one. It works for 10 minutes.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await heading('Check your email');
    expect(auth.signIn).toHaveBeenLastCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } });
    await user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await user.click(screen.getByRole('button', { name: 'I can’t use my passkey' }));
    await heading('Can’t use your passkey?');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeTruthy();
    cleanup();

    const second = setup({ emailCodeEnabled: false });
    await second.user.click(screen.getByRole('button', { name: 'Trouble signing in?' }));
    await second.user.click(screen.getByRole('button', { name: 'I can’t use my passkey' }));
    await heading('Can’t use your passkey?');
    expect(screen.queryByRole('button', { name: 'Email me a code' })).toBeNull();
    expect(screen.queryByLabelText('Email address')).toBeNull();
  });
});

describe('passkey sign-in', () => {
  it('signs in and goes to the safe `next` path', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup();
    await enterEmail(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
    expect(auth.signIn).toHaveBeenCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } });
  });

  it('never redirects off-site', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ next: '//evil.example/steal', defaultNext: '/home' });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/home'));
  });

  it('honors allowed redirect prefixes', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ next: '/admin/people', allowedRedirectPrefixes: ['/reports'] });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('a closed prompt gets a calm note (not an error), keeps the other ways in, and "Try again" asks again', async () => {
    auth.signIn.mockRejectedValueOnce(awsError('PasskeyAuthenticationCanceled')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup();
    await user.type(emailField(), 'ada@example.org{Enter}');
    const note = await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    expect(note.closest('[role="status"]')?.getAttribute('data-auth-kit-slot')).toBe('note');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Waiting for your passkey…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a code instead' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });

  it('an account without a passkey gets a passkey prompt that finds nothing, never a list of its other methods (ADR 0018)', async () => {
    const browser = stubPasskeyBrowser();
    auth.signIn.mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['PASSWORD', 'PASSWORD_SRP'] }));
    auth.signIn.mockResolvedValueOnce(TOTP_STEP);
    auth.confirmSignIn.mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup();
    await user.type(emailField(), 'ada@example.org{Enter}');

    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    expect(browser.get).toHaveBeenCalledTimes(1);
    const options = browser.get.mock.calls[0]![0] as { publicKey: { allowCredentials: { id: Uint8Array }[]; userVerification: string } };
    expect(options.publicKey.userVerification).toBe('required');
    expect(options.publicKey.allowCredentials).toHaveLength(2); // random IDs: no passkey can match
    expect(screen.queryByRole('heading', { name: /Choose how/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use your password' })).toBeNull();
    expect(auth.confirmSignIn).not.toHaveBeenCalled(); // nothing answered Cognito's SELECT_CHALLENGE

    // The person picks their password themselves, then the authenticator code, as anyone would.
    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
    await user.type(await screen.findByLabelText('Password'), 'my password{Enter}');
    await heading('Enter your authenticator code');
    await user.type(screen.getByLabelText('6-digit code'), '123 456{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '123456' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('the decoy prompt asks with the pool’s relying-party ID and timeout when the site gives them, and the defaults otherwise', async () => {
    const browser = stubPasskeyBrowser();
    type Options = { publicKey: { rpId?: string; timeout?: number } };
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['EMAIL_OTP'] }));
    let { user } = setup({ passkey: { relyingPartyId: 'reports.example.org', timeoutMs: 120_000 } });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    expect(browser.get).toHaveBeenCalledTimes(1);
    const given = (browser.get.mock.calls[0]![0] as Options).publicKey;
    expect(given.rpId).toBe('reports.example.org');
    expect(given.timeout).toBe(120_000);
    cleanup();

    // A disabled account's decoy carries them too (the refusal path).
    auth.signIn.mockRejectedValue(awsError('NotAuthorizedException', 'User is disabled.'));
    ({ user } = setup({ passkey: { relyingPartyId: 'reports.example.org', timeoutMs: 120_000 } }));
    await user.type(emailField(), 'ada@example.org{Enter}');
    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    expect((browser.get.mock.calls[1]![0] as Options).publicKey).toMatchObject({ rpId: 'reports.example.org', timeout: 120_000 });
    cleanup();

    // Without them: the browser's own (the page's domain) and 3 minutes, as before.
    ({ user } = setup());
    await user.type(emailField(), 'ada@example.org{Enter}');
    await screen.findByText('We didn’t get a passkey. Try again, or use another way below.');
    const defaults = (browser.get.mock.calls[2]![0] as Options).publicKey;
    expect('rpId' in defaults).toBe(false);
    expect(defaults.timeout).toBe(180_000);
  });

  it('a browser without passkeys says so the same way for every address', async () => {
    // No stubPasskeyBrowser(): jsdom has no WebAuthn, like a browser without passkey support.
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['SMS_OTP'] }));
    const { user } = setup();
    await user.type(emailField(), 'ada@example.org{Enter}');
    expect((await findSummary()).textContent).toBe('This browser can’t use passkeys here. Use another way below.');
    expect(screen.queryByText('Waiting for your passkey…')).toBeNull();
  });
});

describe('password sign-in', () => {
  it('the password (Continue), then the authenticator code (Sign in)', async () => {
    auth.signIn.mockResolvedValue(TOTP_STEP);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup();
    await submitPassword(user);
    expect(auth.signIn).toHaveBeenCalledWith({
      username: 'ada@example.org',
      password: 'my long password',
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
    });
    await heading('Enter your authenticator code');
    expect(screen.getByText('Open your authenticator app or password manager and enter the 6-digit code for Example Reports.')).toBeTruthy();
    expect(submitButtons()).toEqual(['Sign in']);
    expect(screen.getByLabelText('6-digit code').getAttribute('autocomplete')).toBe('one-time-code');
    await user.type(screen.getByLabelText('6-digit code'), '12345{Enter}');
    expect(summary().textContent).toBe('Enter the 6-digit code from your authenticator app');
    expect(auth.confirmSignIn).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('6-digit code'), '6{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
  });

  it('"Lost your authenticator app?" opens its help screen', async () => {
    auth.signIn.mockResolvedValue(TOTP_STEP);
    const { user } = setup();
    await submitPassword(user);
    await heading('Enter your authenticator code');
    await user.click(screen.getByRole('button', { name: 'Lost your authenticator app?' }));
    await heading('Lost your authenticator app?');
    expect(screen.queryByRole('button', { name: /Email me a code/ })).toBeNull();
  });

  it('a wrong authenticator code keeps the session and marks the field', async () => {
    auth.signIn.mockResolvedValue(TOTP_STEP);
    auth.confirmSignIn.mockRejectedValueOnce(awsError('CodeMismatchException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup();
    await submitPassword(user);
    await heading('Enter your authenticator code');
    await user.type(screen.getByLabelText('6-digit code'), '000000{Enter}');
    expect((await findSummary()).textContent).toBe('That code didn’t work. Codes change every 30 seconds, so enter the newest one.');
    const field = screen.getByLabelText('6-digit code');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(inlineError(field)).toBe('Error: That code didn’t work. Codes change every 30 seconds, so enter the newest one.');
    await user.clear(field);
    await user.type(field, '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('says the same thing for a wrong password and an unknown account', async () => {
    const messages: string[] = [];
    for (const error of [awsError('NotAuthorizedException', 'Incorrect username or password.'), awsError('UserNotFoundException', 'User does not exist.')]) {
      auth.signIn.mockRejectedValueOnce(error);
      const { user } = setup();
      await submitPassword(user);
      messages.push((await findSummary()).textContent ?? '');
      const password = screen.getByLabelText('Password');
      expect(password.getAttribute('aria-invalid')).toBe('true');
      expect(inlineError(password)).toBe(`Error: ${messages.at(-1)}`);
      cleanup();
    }
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toBe('That email address and password don’t match. Try again, or use another way to sign in.');
  });

  it('an empty password is caught before Cognito', async () => {
    const { user } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Enter your password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(summary().textContent).toBe('Enter your password');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('tells people to wait when rate-limited (Cognito or WAF)', async () => {
    auth.signIn.mockRejectedValue(awsError('ForbiddenException', 'Request not allowed due to WAF block.'));
    const { user } = setup();
    await submitPassword(user);
    expect((await findSummary()).textContent).toBe('Too many attempts from this network. Wait 5 minutes, then try again.');
  });

  it('starts over with the email kept when the sign-in session expires on the authenticator step', async () => {
    auth.signIn.mockResolvedValue(TOTP_STEP);
    auth.confirmSignIn.mockRejectedValue(SESSION_EXPIRED());
    const { user } = setup();
    await submitPassword(user);
    await heading('Enter your authenticator code');
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await heading('Sign in to Example Reports');
    expect(summary().textContent).toBe('That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.');
    expect(emailField().value).toBe('ada@example.org');
  });

  it('"Forgot your password?": a reset code, a new password, then signed straight in to the authenticator step', async () => {
    auth.signIn.mockResolvedValue(TOTP_STEP);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
    await heading('Forgot your password?');
    await user.click(screen.getByRole('button', { name: 'Send a reset code' }));
    expect(auth.resetPassword).toHaveBeenCalledWith({ username: 'ada@example.org' });

    await heading('Check your email');
    expect(screen.getByText('If ada@example.org has an account here, we’ve emailed it a code to reset your password. It works for 1 hour.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' }).disabled).toBe(true);
    expect(submitButtons()).toEqual(['Continue']);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(summary().textContent).toBe('Enter the code from the email');
    await user.type(screen.getByLabelText('Reset code'), '1234 5678{Enter}');

    await heading('Choose a new password');
    expect(screen.getByText('Next, you’ll enter your authenticator code as usual.')).toBeTruthy();
    await user.type(screen.getByLabelText('New password'), 'too short{Enter}');
    expect(summary().textContent).toBe('Choose a password with at least 15 characters');
    expect(auth.confirmResetPassword).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New password'), ' but now long enough{Enter}');

    await heading('Enter your authenticator code');
    expect(auth.confirmResetPassword).toHaveBeenCalledWith({ username: 'ada@example.org', confirmationCode: '12345678', newPassword: 'too short but now long enough' });
    expect(auth.signIn).toHaveBeenLastCalledWith({
      username: 'ada@example.org',
      password: 'too short but now long enough',
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
    });
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('a wrong reset code goes back to the code screen with the message', async () => {
    auth.confirmResetPassword.mockRejectedValueOnce(awsError('CodeMismatchException'));
    const { user } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
    await user.click(await screen.findByRole('button', { name: 'Send a reset code' }));
    await user.type(await screen.findByLabelText('Reset code'), '11111111{Enter}');
    await user.type(await screen.findByLabelText('New password'), 'a brand new long password{Enter}');
    await heading('Check your email');
    expect((await findSummary()).textContent).toBe('That code didn’t work. Check it and try again.');
    expect(screen.getByLabelText('Reset code').getAttribute('aria-invalid')).toBe('true');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('rejects a breached new password at reset before sending it', async () => {
    const check = vi.fn().mockResolvedValue(true);
    const { user } = setup({ passkeysEnabled: false, checkBreachedPassword: check });
    await user.type(emailField(), 'ada@example.org{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
    await user.click(await screen.findByRole('button', { name: 'Send a reset code' }));
    await user.type(await screen.findByLabelText('Reset code'), '11111111{Enter}');
    await user.type(await screen.findByLabelText('New password'), 'password123456789{Enter}');
    expect((await findSummary()).textContent).toBe('This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.');
    expect(check).toHaveBeenCalledWith('password123456789');
    expect(auth.confirmResetPassword).not.toHaveBeenCalled();
  });

  it('"Forgot your password?" answers the same whether or not the account exists', async () => {
    auth.resetPassword.mockRejectedValue(awsError('UserNotFoundException'));
    const { user } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'nobody@example.org{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Forgot your password?' }));
    await user.click(await screen.findByRole('button', { name: 'Send a reset code' }));
    await heading('Check your email');
    expect(screen.getByText('If nobody@example.org has an account here, we’ve emailed it a code to reset your password. It works for 1 hour.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a password that must be reset reads like a wrong password, with "Forgot your password?" as the way on (RESET_REQUIRED, ADR 0018)', async () => {
    // Amplify turns PasswordResetRequiredException into the RESET_PASSWORD step; either way, the same screen.
    const answers = [
      () => auth.signIn.mockResolvedValue(next({ signInStep: 'RESET_PASSWORD' })),
      () => auth.signIn.mockRejectedValue(awsError('PasswordResetRequiredException', 'Password reset required for the user')),
    ];
    for (const answer of answers) {
      answer();
      auth.resetPassword.mockClear();
      const { user } = setup();
      await submitPassword(user);
      expect((await findSummary()).textContent).toBe('That email address and password don’t match. Try again, or use another way to sign in.');
      expect(screen.getByRole('heading', { name: 'Enter your password' })).toBeTruthy();
      expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
      expect(document.body.textContent).not.toMatch(/choose a new password/i);
      await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
      await heading('Forgot your password?');
      await user.click(screen.getByRole('button', { name: 'Send a reset code' }));
      expect(auth.resetPassword).toHaveBeenCalledWith({ username: 'ada@example.org' });
      await heading('Check your email');
      cleanup();
    }
  });
});

describe('emailed code (the backstop) and joining', () => {
  it('sends a code, words a wrong one with the site’s name, then a fresh invite must choose, and creates a passkey', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockRejectedValueOnce(awsError('CodeMismatchException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({}, [FRESH_INVITE, DONE_FACTORS]);
    await askForCode(user);
    expect(auth.signIn.mock.calls[0]![0].options.preferredChallenge).toBe('EMAIL_OTP');
    // The typed address, never Cognito's masked one: an unknown address has none (ADR 0018).
    expect(screen.getByText('If ada@example.org has an account here, we’ve emailed it an 8-digit code. It works for 10 minutes.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('a***@e***');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Use a different email address' })).toBeTruthy();
    expect(submitButtons()).toEqual(['Sign in']);
    expect(screen.getByText(/^No email after a minute\? Check your junk folder/)).toBeTruthy();
    await user.type(screen.getByLabelText('8-digit code'), '1234{Enter}');
    expect(summary().textContent).toBe('Enter the 8-digit code from the email');
    await user.clear(screen.getByLabelText('8-digit code'));
    await user.type(screen.getByLabelText('8-digit code'), '1234 5678{Enter}');
    expect((await findSummary()).textContent).toBe('That code didn’t work. Check it against the newest email from Example Reports.');
    expect(screen.getByLabelText('8-digit code').getAttribute('aria-invalid')).toBe('true');
    await user.clear(screen.getByLabelText('8-digit code'));
    await user.type(screen.getByLabelText('8-digit code'), '87654321{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '87654321' });

    await heading('Choose how you’ll sign in next time');
    expect(screen.getByText('A passkey is quickest. You can add another way later under My account.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Passkey (recommended)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Password and authenticator app' })).toBeTruthy();
    expect(screen.getByText('Don’t create a passkey on a shared computer.')).toBeTruthy();
    // The first credential is required: no way to skip it.
    expect(screen.queryByRole('button', { name: /Not now|Skip|Later/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trouble signing in?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    expect(auth.associateWebAuthnCredential).toHaveBeenCalledTimes(1);

    await heading('You’re set up');
    expect(screen.getByText('Next time, choose your passkey when you sign in to Example Reports.')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Continue to Example Reports' }));
    expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes');
  });

  it('creating the passkey: the browser’s window is the step, a failure says so, and "Try again" asks again', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const first = deferred<undefined>();
    auth.associateWebAuthnCredential.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    const { user } = setup({}, [FRESH_INVITE]);
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Create a passkey' }));
    await heading('Create a passkey');
    expect(screen.getByText('Waiting for your device…')).toBeTruthy();
    expect(screen.getByText('Want the passkey on your phone? Choose the phone option in the window that opens.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a password instead' })).toBeTruthy();
    await act(async () => {
      first.reject(awsError('PasskeyRegistrationCanceled'));
      await Promise.resolve();
    });
    expect((await findSummary()).textContent).toBe('We couldn’t create your passkey. Try again, or use a password instead.');
    expect(screen.queryByText('Waiting for your device…')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await heading('You’re set up');
    expect(auth.associateWebAuthnCredential).toHaveBeenCalledTimes(2);
  });

  it('joining with a password: Create a password (15 or more), Add an authenticator app, then You’re set up', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' }));
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ securityNotices: true }, [FRESH_INVITE]);
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');

    await heading('Choose how you’ll sign in next time');
    await user.click(screen.getByRole('button', { name: 'Use a password instead' }));
    await heading('Create a password');
    expect(screen.getByText('At least 15 characters. A few words make a good one, or let your password manager create it.')).toBeTruthy();
    const field = screen.getByLabelText('New password');
    expect(field.getAttribute('autocomplete')).toBe('new-password');
    expect(field.getAttribute('minlength')).toBe('15');
    expect(field.hasAttribute('maxlength')).toBe(false);
    expect(screen.queryByRole('button', { name: /Not now|Skip/ })).toBeNull();
    await user.type(field, 'fourteen chars{Enter}');
    expect(summary().textContent).toBe('Choose a password with at least 15 characters');
    await user.clear(field);
    await user.click(field);
    await user.paste('pasted-from-a-password-manager');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(changePasswordWithoutPrevious).toHaveBeenCalledWith('pasted-from-a-password-manager'));

    await heading('Add an authenticator app');
    expect(screen.queryByRole('button', { name: /Not now|Cancel/ })).toBeNull();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(auth.verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456' }));
    expect(auth.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });

    await heading('You’re set up');
    expect(screen.getByText('Next time, sign in with your password and a code from your authenticator app. We’ve emailed you a note about this.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue to Example Reports' }));
    expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes');
  });

  it('a breached first password is refused before saving', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const check = vi.fn().mockResolvedValue(true);
    const { user } = setup({ passkeysEnabled: false, checkBreachedPassword: check }, [FRESH_INVITE]);
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
    await user.type(await screen.findByLabelText('New password'), 'password123456789{Enter}');
    expect((await findSummary()).textContent).toBe('This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.');
    expect(changePasswordWithoutPrevious).not.toHaveBeenCalled();
  });

  it('with passkeys off, the first credential is a password straight away', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user } = setup({ passkeysEnabled: false }, [FRESH_INVITE]);
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
    await heading('Create a password');
    expect(screen.queryByRole('heading', { name: /Choose how/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Not now|Skip/ })).toBeNull();
  });

  it('codeLifetimeMinutes 10: the code screen says so, and so does the expired session, with "Start again"', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockRejectedValue(SESSION_EXPIRED());
    const { user } = setup({ codeLifetimeMinutes: 10 });
    await askForCode(user);
    expect(screen.getByText('If ada@example.org has an account here, we’ve emailed it an 8-digit code. It works for 10 minutes.')).toBeTruthy();
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
    expect((await findSummary()).textContent).toBe('That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.');
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(screen.queryByLabelText('8-digit code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    await heading('Sign in to Example Reports');
    expect(emailField().value).toBe('ada@example.org');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the default lifetime is 10 minutes, and an out-of-range one is refused', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockRejectedValue(SESSION_EXPIRED());
    const { user } = setup();
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');
    expect((await findSummary()).textContent).toBe('That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.');
    cleanup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => setup({ codeLifetimeMinutes: 20 })).toThrow(/codeLifetimeMinutes must be a whole number of minutes from 3 to 15/);
    } finally {
      error.mockRestore();
    }
  });

  it('"Send a new code" waits 30 seconds, then says when the newest one was sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 23, 14, 5, 0));
    auth.signIn.mockResolvedValue(CODE_SENT);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    render(createElement(SignIn, { siteName: 'Example Reports', help: HELP, passkeysEnabled: true, navigate: vi.fn(), loadFactors: vi.fn(), checkBreachedPassword: false }));
    await askForCode(user);
    const resend = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' });
    expect(resend().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(resend().disabled).toBe(false);
    await user.click(resend());
    const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 9, 23, 14, 5, 30));
    expect(await screen.findByText(`We sent a new code at ${at}. Use the newest one.`)).toBeTruthy();
    expect(auth.signIn).toHaveBeenCalledTimes(2);
    expect(resend().disabled).toBe(true);
  });

  it('"Use a different email address" goes back to the email', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    const { user } = setup();
    await askForCode(user);
    await user.click(screen.getByRole('button', { name: 'Use a different email address' }));
    await heading('Sign in to Example Reports');
    expect(emailField().value).toBe('ada@example.org');
  });
});

describe('after sign-in', () => {
  it('a password user without an authenticator gets only the setup screen', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ passkeysEnabled: false }, [{ configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] }, { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }]);
    await user.type(emailField(), 'ada@example.org{Enter}');
    await user.type(await screen.findByLabelText('Password'), 'my long password{Enter}');
    await heading('Add an authenticator app');
    expect(screen.getByText('You sign in with a password, so this site also asks for a code from an authenticator app. It only takes a minute.')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    const link = await screen.findByRole('link', { name: 'On this device? Open the setup link.' });
    expect(link.getAttribute('href')).toBe(`otpauth://totp/Example%20Reports:ada%40example.org?secret=${TEST_SECRET}&issuer=Example%20Reports`);
    expect(screen.queryByRole('button', { name: /Not now|Cancel/ })).toBeNull();
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('offers a passkey once; "Not now" is remembered on this device', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const passwordOnly = { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] };
    let { user, navigate } = setup({}, [passwordOnly]);
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Create a passkey on this device?');
    expect(screen.getByText('Next time, sign in with your face, fingerprint, or device PIN. Nothing to remember or type.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(navigate).toHaveBeenCalled();
    cleanup();

    ({ user, navigate } = setup({}, [passwordOnly]));
    await user.type(emailField(), 'ada@example.org{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Create a passkey on this device?' })).toBeNull();
  });

  it('the offer’s "Create a passkey" saves one and goes on', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({}, [{ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }]);
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Create a passkey on this device?');
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/42?tab=notes'));
    expect(auth.associateWebAuthnCredential).toHaveBeenCalledTimes(1);
  });

  it('confirming it’s you never shows the offer', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ reauth: true }, [{ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }]);
    await waitFor(() => expect(emailField().value).toBe('ada@example.org'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Create a passkey on this device?' })).toBeNull();
  });

  const CHECK_FAILED = 'We couldn’t check how you sign in. Try again. If it keeps happening, email apps-help@example.org.';

  it('a failed factor check after an emailed code never goes in: "Try again" re-reads, and a fresh invite must then choose (ADR 0024)', async () => {
    auth.signIn.mockResolvedValue(CODE_SENT);
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const navigate = vi.fn();
    const loadFactors = vi.fn<() => Promise<ClientAuthFactors>>().mockRejectedValueOnce(awsError('NetworkError')).mockResolvedValue(FRESH_INVITE);
    const user = userEvent.setup();
    render(createElement(SignIn, { siteName: 'Example Reports', help: HELP, passkeysEnabled: true, navigate, loadFactors, checkBreachedPassword: false }));
    await askForCode(user);
    await user.type(screen.getByLabelText('8-digit code'), '12345678{Enter}');

    const note = await screen.findByText(CHECK_FAILED);
    expect(note.closest('[data-auth-kit-slot="note"]')).not.toBeNull();
    expect(root().getAttribute('data-auth-kit-view')).toBe('check-failed');
    expect(screen.getByRole('heading', { name: 'Sign in to Example Reports' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loadFactors).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await heading('Choose how you’ll sign in next time');
    expect(loadFactors).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a factor check that keeps failing (or reads nothing) keeps offering "Try again", and goes on once it reads', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    const navigate = vi.fn();
    const loadFactors = vi
      .fn<() => Promise<ClientAuthFactors>>()
      .mockRejectedValueOnce(awsError('NotAuthorizedException', 'Access Token has been revoked'))
      // A site's own loader that answers nothing is no answer either.
      .mockResolvedValueOnce(undefined as unknown as ClientAuthFactors)
      .mockResolvedValue(DONE_FACTORS);
    const user = userEvent.setup();
    render(createElement(SignIn, { siteName: 'Example Reports', help: HELP, passkeysEnabled: true, navigate, loadFactors }));
    await user.type(emailField(), 'ada@example.org{Enter}');
    await screen.findByText(CHECK_FAILED);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(loadFactors).toHaveBeenCalledTimes(2));
    await screen.findByText(CHECK_FAILED);
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(loadFactors).toHaveBeenCalledTimes(3);
  });
});

describe('admin-created accounts (temporary password)', () => {
  it('NEW_PASSWORD_REQUIRED, then MFA_SETUP with the key Cognito issued', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: [] }));
    auth.confirmSignIn
      .mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails: { sharedSecret: TEST_SECRET } }))
      .mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({ passkeysEnabled: false, emailCodeEnabled: false });
    await user.type(emailField(), 'admin@example.org{Enter}');
    await user.type(await screen.findByLabelText('Password'), 'Temp-123{Enter}');

    await heading('Choose a new password');
    expect(screen.getByText('Your temporary password worked. Now choose your own.')).toBeTruthy();
    await user.type(screen.getByLabelText('New password'), 'short{Enter}');
    expect(summary().textContent).toBe('Choose a password with at least 15 characters');
    expect(auth.confirmSignIn).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('New password'), ' and now long enough{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'short and now long enough' });

    await heading('Add an authenticator app');
    expect(screen.getByText('This account needs an authenticator app. Add it now to finish signing in.')).toBeTruthy();
    expect(screen.getByLabelText('Setup key').textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(auth.setUpTOTP).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy();
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
    await user.type(emailField(), 'admin@example.org{Enter}');
    await user.type(await screen.findByLabelText('Password'), 'Temp-123{Enter}');
    await user.type(await screen.findByLabelText('New password'), 'password123456789{Enter}');
    expect((await findSummary()).textContent).toBe('This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.');
    expect(inlineError(screen.getByLabelText('New password'))).toBe('Error: This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.');
    expect(auth.confirmSignIn).not.toHaveBeenCalled();
  });

  it('refuses a temporary-password account with missing attributes, plainly', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: ['name'] }));
    const { user } = setup({ passkeysEnabled: false });
    await user.type(emailField(), 'admin@example.org{Enter}');
    await user.type(await screen.findByLabelText('Password'), 'Temp-123{Enter}');
    await heading('Sign in to Example Reports');
    expect((await findSummary()).textContent).toBe('This account is missing details this screen can’t collect. Email apps-help@example.org.');
  });
});

describe('unsupported steps and step-up', () => {
  it('names an unsupported step plainly, with the help address', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' }));
    const { user } = setup();
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Sign in to Example Reports');
    expect((await findSummary()).textContent).toBe('This account needs a sign-in step this site doesn’t support. Email apps-help@example.org.');
  });

  it('reauth: says why, prefills the email, and replaces the existing session', async () => {
    auth.signIn.mockRejectedValueOnce(awsError('UserAlreadyAuthenticatedException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({ reauth: true });
    expect(screen.getByRole('heading', { name: 'Confirm it’s you', level: 1 })).toBeTruthy();
    expect(screen.getByText('For your security, sign in again to continue.')).toBeTruthy();
    await waitFor(() => expect(emailField().value).toBe('ada@example.org'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(auth.signOut).toHaveBeenCalledWith();
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });
});

describe('styling hooks', () => {
  it('exposes data-auth-kit slots and className / classNames props', async () => {
    auth.signIn.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    render(
      createElement(SignIn, {
        siteName: 'X',
        help: HELP,
        passkeysEnabled: true,
        className: 'site-signin',
        classNames: { button: 'btn', input: 'field-input', card: 'site-card', secondaryButton: 'btn-2' },
      }),
    );
    expect(root().className).toBe('site-signin');
    expect(root().getAttribute('data-auth-kit-view')).toBe('email');
    expect(card().className).toBe('site-card');
    expect(screen.getByRole('button', { name: 'Continue' }).className).toBe('btn');
    expect(emailField().className).toBe('field-input');
    expect(root().querySelector('[data-auth-kit-slot="linkButton"]')).not.toBeNull();
    expect(root().querySelector('[data-auth-kit-slot="alts"]')).not.toBeNull();
    await user.type(emailField(), 'ada@example.org{Enter}');
    await heading('Use your passkey');
    expect(root().getAttribute('data-auth-kit-view')).toBe('passkey');
    expect(screen.getByRole('button', { name: 'Try again' }).className).toBe('btn-2');
    expect(root().querySelector('[data-auth-kit-slot="wait"] [data-auth-kit-icon="fingerprint"]')).not.toBeNull();
  });
});
