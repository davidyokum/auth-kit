// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { type ClientAuthFactors, SignUp, type SignUpProps } from '../../src/client/index.js';
import { hasPasskeyHint } from '../../src/client/passkey-hint.js';
import { auth, awsError, next, resetAmplifyMocks, SIGNED_IN } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

// The first password goes to Cognito's own endpoint (no Amplify wrapper): never from a test.
const changePasswordWithoutPrevious = vi.hoisted(() => vi.fn());
vi.mock('../../src/client/cognito.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CognitoModule>()),
  changePasswordWithoutPrevious,
}));

const HELP = { address: 'apps-help@example.org' };
const DOMAINS = { mode: 'domains', domains: ['example.org'] } as const;
const CODE_SENT = next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } });
const FRESH: ClientAuthFactors = { configured: ['EMAIL_OTP'], mfa: [] };

/** A sign-up route's JSON answer. */
function answer(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function setup(props: Partial<SignUpProps> = {}, factors: ClientAuthFactors = FRESH) {
  const navigate = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(() => answer({ ok: true }));
  const loadFactors = vi.fn(() => Promise.resolve(factors));
  const user = userEvent.setup();
  render(
    createElement(SignUp, {
      siteName: 'Example Reports',
      help: HELP,
      accountCreation: DOMAINS,
      privacyNoticeUrl: '/privacy',
      passkeysEnabled: true,
      navigate,
      loadFactors,
      fetch,
      checkBreachedPassword: false,
      ...props,
    }),
  );
  return { navigate, fetch, loadFactors, user };
}

type User = ReturnType<typeof userEvent.setup>;
const root = () => document.querySelector<HTMLElement>('[data-auth-kit="sign-up"]')!;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
const emailField = () => screen.getByLabelText<HTMLInputElement>('Email address');
const inlineError = (field: HTMLElement) => document.getElementById(`${field.id}-error`)?.textContent ?? null;

async function submitEmail(user: User, email = 'ada@example.org') {
  await user.type(emailField(), `${email}{Enter}`);
}

// No network from tests: anything that reaches the real fetch (Cognito's endpoint, a route) fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));
// The account-change notice route is the site's own (register A10: notices are on by default); here it isn't mounted.
const guardedFetch = (input: unknown) =>
  String(input) === '/api/auth-kit/account-notice' ? Promise.resolve(new Response('', { status: 404 })) : noNetwork(input);

beforeEach(() => {
  resetAmplifyMocks();
  window.sessionStorage.clear();
  auth.signIn.mockResolvedValue(CODE_SENT);
  changePasswordWithoutPrevious.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', guardedFetch);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'AwsWafIntegration');
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
});

describe('SignUp: the email', () => {
  it('domains mode: the domain hint, the family’s example, the privacy line, and "Already have an account?"', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Create your account', level: 1 })).toBeTruthy();
    const email = emailField();
    expect(email.getAttribute('placeholder')).toBe('name@example.com');
    expect(email.getAttribute('autocomplete')).toBe('email');
    const hint = root().querySelector('[data-auth-kit-slot="hint"]')!;
    expect(hint.textContent).toBe('Use your example.org email address');
    expect(email.getAttribute('aria-describedby')).toContain(hint.id);
    const privacy = screen.getByRole('link', { name: 'Privacy notice' });
    expect(privacy.getAttribute('href')).toBe('/privacy');
    expect(privacy.parentElement!.textContent).toBe('Privacy notice: what Example Reports keeps about you, and why.');
    expect(screen.queryByText(/By creating an account/)).toBeNull();
    expect(screen.queryByText('You’ll confirm your address with a code.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByRole('link', { name: 'Sign in' }).parentElement!.textContent).toBe('Already have an account? Sign in');
  });

  it('lists several domains with the Oxford comma, and a site may word the hint itself', () => {
    setup({ accountCreation: { mode: 'domains', domains: ['example.org', 'example.net', 'edu'] }, theme: 'unc' });
    expect(root().querySelector('[data-auth-kit-slot="hint"]')!.textContent).toBe('Use your example.org, example.net, or .edu email address');
    expect(emailField().getAttribute('placeholder')).toBe('name@unc.edu');
    cleanup();
    setup({ domainHint: 'Use your work address', emailHint: 'name@example.org' });
    expect(root().querySelector('[data-auth-kit-slot="hint"]')!.textContent).toBe('Use your work address');
    expect(emailField().getAttribute('placeholder')).toBe('name@example.org');
  });

  it('checks the address before posting: empty, then malformed', async () => {
    const { user, fetch } = setup();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter your email address');
    await submitEmail(user, 'ada');
    expect(screen.getByRole('alert').textContent).toBe('Enter an email address like name@example.com');
    expect(inlineError(emailField())).toBe('Error: Enter an email address like name@example.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an address off the list gets the not-on-list message here, without posting, and no way to ask', async () => {
    const { user, fetch } = setup();
    await submitEmail(user, 'ada@elsewhere.example');
    const message = 'Example Reports accounts are for example.org addresses. Use one of those, or ask the person who runs it to add you.';
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(inlineError(emailField())).toBe(`Error: ${message}`);
    expect(emailField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Ask for access instead' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('with requestsAlso, "Ask for access instead" hands the address to the request form (never in the URL)', async () => {
    const { user, fetch, navigate } = setup({ accountCreation: { ...DOMAINS, requestsAlso: true }, requestAccessHref: '/ask-for-access' });
    await submitEmail(user, 'ada@elsewhere.example');
    expect(screen.getByRole('alert').textContent).toBe('Example Reports accounts are for example.org addresses. Use one of those, or ask for access.');
    await user.click(screen.getByRole('button', { name: 'Ask for access instead' }));
    expect(window.sessionStorage.getItem('auth-kit:request-access-email')).toBe('ada@elsewhere.example');
    expect(navigate).toHaveBeenCalledWith('/ask-for-access');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the route’s answer: not on the list (with the offer to ask), rate-limited, or unavailable', async () => {
    const cases = [
      [{ ok: false, code: 'not_on_list', error: 'Example Reports accounts are for example.org addresses. Use one of those, or ask for access.', field: 'email', requestAccess: true }, 403, true, true],
      [{ ok: false, code: 'rate_limited', error: 'Too many attempts from this network. Wait 5 minutes, then try again.', retryAfterSeconds: 300 }, 429, false, false],
      [{ ok: false, code: 'unavailable', error: 'We couldn’t create accounts just now. Try again in a few minutes.' }, 503, false, false],
    ] as const;
    for (const [body, status, onField, offersRequest] of cases) {
      const { user, fetch } = setup();
      fetch.mockImplementation(() => answer(body, status));
      await submitEmail(user);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(body.error));
      expect(emailField().getAttribute('aria-invalid') === 'true', body.code).toBe(onField);
      expect(screen.queryByRole('button', { name: 'Ask for access instead' }) !== null, body.code).toBe(offersRequest);
      expect(auth.signIn).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Create your account' })).toBeTruthy();
      cleanup();
    }
  });

  it('a network failure names the help address', async () => {
    const { user, fetch } = setup();
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await submitEmail(user);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('We couldn’t reach the sign-in service. Check your connection and try again. If it keeps happening, email apps-help@example.org.'),
    );
  });

  it('open mode: anyone, the open line, a generic example, the terms sentence, and the bot note', () => {
    setup({ accountCreation: { mode: 'open' }, theme: 'osbm', termsUrl: '/terms', botNote: true });
    expect(screen.getByText('You’ll confirm your address with a code.')).toBeTruthy();
    expect(root().querySelector('[data-auth-kit-slot="hint"]')).toBeNull();
    expect(emailField().getAttribute('placeholder')).toBe('name@example.com');
    const terms = screen.getByRole('link', { name: 'terms' });
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(screen.getByRole('link', { name: 'privacy notice' }).getAttribute('href')).toBe('/privacy');
    expect(terms.parentElement!.textContent).toBe('By creating an account you agree to the Example Reports terms and privacy notice.');
    expect(screen.getByText('Protected against automated sign-ups.')).toBeTruthy();
    cleanup();
    // Without terms, the privacy line.
    setup({ accountCreation: { mode: 'open' } });
    expect(screen.getByRole('link', { name: 'Privacy notice' }).parentElement!.textContent).toBe('Privacy notice: what Example Reports keeps about you, and why.');
    expect(screen.queryByText('Protected against automated sign-ups.')).toBeNull();
  });

  it('refuses to render for an invite or request site', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => setup({ accountCreation: { mode: 'invite' } })).toThrow("SignUp needs accountCreation mode 'domains' or 'open' (this site is 'invite')");
      cleanup();
      expect(() => setup({ accountCreation: { mode: 'request' } })).toThrow("SignUp needs accountCreation mode 'domains' or 'open' (this site is 'request')");
    } finally {
      error.mockRestore();
    }
  });
});

describe('SignUp: the code and after', () => {
  it('posts { email } as JSON, then emails a code: "Check your email" and "Continue"', async () => {
    const { user, fetch } = setup();
    await submitEmail(user, ' ada@example.org ');
    await heading('Check your email');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/sign-up');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'ada@example.org' });
    expect(auth.signIn).toHaveBeenCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } });
    expect(screen.getByText('We’ve emailed ada@example.org. Enter the 8-digit code from that email. It works for 10 minutes and confirms the address is yours.')).toBeTruthy();
    expect(screen.getByText('Already have an account? The email explains how to sign in instead.')).toBeTruthy();
    expect(screen.getByText('No email after a minute? Check your junk folder, then send a new code.')).toBeTruthy();
    expect(screen.getByLabelText('8-digit code').getAttribute('autocomplete')).toBe('one-time-code');
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' }).disabled).toBe(true);
    expect(document.body.textContent).not.toContain('a***@e***');
  });

  it('uses a site’s own endpoint, and the lifetime it’s given', async () => {
    const { user, fetch } = setup({ endpoint: '/api/join', codeLifetimeMinutes: 10 });
    await submitEmail(user);
    await heading('Check your email');
    expect(fetch.mock.calls[0]![0]).toBe('/api/join');
    expect(screen.getByText(/It works for 10 minutes and confirms the address is yours\./)).toBeTruthy();
  });

  it('goes through AWS WAF’s integration when the page loaded it and no fetch is given', async () => {
    const wafFetch = vi.fn<typeof globalThis.fetch>(() => answer({ ok: true }));
    Object.defineProperty(window, 'AwsWafIntegration', { value: { fetch: wafFetch }, configurable: true });
    const plainFetch = vi.fn<typeof globalThis.fetch>(() => answer({ ok: true }));
    vi.stubGlobal('fetch', plainFetch);
    const user = userEvent.setup();
    render(createElement(SignUp, { siteName: 'Example Reports', help: HELP, accountCreation: DOMAINS, privacyNoticeUrl: '/privacy', passkeysEnabled: true }));
    await submitEmail(user);
    await heading('Check your email');
    expect(wafFetch).toHaveBeenCalledTimes(1);
    expect(wafFetch.mock.calls[0]![0]).toBe('/api/auth/sign-up');
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it('a fresh account: Continue, "Your name", "Choose how you’ll sign in next time", then "You’re set up" as a member', async () => {
    auth.confirmSignIn.mockRejectedValueOnce(awsError('CodeMismatchException')).mockResolvedValueOnce(SIGNED_IN);
    const { user, navigate } = setup({ next: '/reports' });
    await submitEmail(user);
    await heading('Check your email');
    await user.type(screen.getByLabelText('8-digit code'), '1234{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Enter the 8-digit code from the email');
    await user.clear(screen.getByLabelText('8-digit code'));
    await user.type(screen.getByLabelText('8-digit code'), '1234 5678{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That code didn’t work. Check it against the newest email from Example Reports.'));
    await user.clear(screen.getByLabelText('8-digit code'));
    await user.type(screen.getByLabelText('8-digit code'), '87654321{Enter}');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: '87654321' });

    await heading('Your name');
    expect(screen.getByText('This is how you’ll appear on Example Reports.')).toBeTruthy();
    expect(screen.getByLabelText('First name').getAttribute('autocomplete')).toBe('given-name');
    expect(screen.getByLabelText('Last name').getAttribute('autocomplete')).toBe('family-name');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter your name');
    expect(auth.updateUserAttributes).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('First name'), ' Ada ');
    await user.type(screen.getByLabelText('Last name'), 'Lovelace');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(auth.updateUserAttributes).toHaveBeenCalledWith({ userAttributes: { given_name: 'Ada', family_name: 'Lovelace', name: 'Ada Lovelace' } }),
    );
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });

    await heading('Choose how you’ll sign in next time');
    expect(screen.queryByRole('button', { name: /Not now|Skip/ })).toBeNull();
    window.localStorage.clear();
    expect(await hasPasskeyHint('ada@example.org')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Create a passkey' }));
    await heading('You’re set up');
    expect(auth.associateWebAuthnCredential).toHaveBeenCalled();
    // The passkey hint (register A5a, L9): next time, Continue opens the passkey prompt for this address.
    await waitFor(async () => expect(await hasPasskeyHint('ada@example.org')).toBe(true));
    expect(await hasPasskeyHint('grace@example.org')).toBe(false);
    expect(screen.getByText('Your account starts as a member of Example Reports. The Example Reports team can give you more access if you need it.')).toBeTruthy();
    expect(screen.queryByText('We’ve emailed you a note about how you’ll sign in next time.')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Continue to Example Reports' }));
    expect(navigate).toHaveBeenCalledWith('/reports');
  });

  it('names the owner in a named family, says when a note was emailed, and "Finish" when the site chose it', async () => {
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user } = setup({ theme: 'osbm', help: { address: 'apps-help@example.org', owner: 'Jordan Lee' }, nameButton: 'finish', notices: { fetch: vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true }))) }, passkeysEnabled: false });
    await submitEmail(user, 'ada@osbm.example.org');
    await user.type(await screen.findByLabelText('8-digit code'), '12345678{Enter}');
    await heading('Your name');
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    await user.type(screen.getByLabelText('First name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    // Passkeys off: straight to the password.
    await heading('Create a password');
    window.localStorage.clear();
    await user.type(screen.getByLabelText('New password'), 'a brand new long password{Enter}');
    await waitFor(() => expect(changePasswordWithoutPrevious).toHaveBeenCalledWith('a brand new long password'));
    await heading('Add an authenticator app');
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await heading('You’re set up');
    expect(screen.getByText('Your account starts as a member of Example Reports. Jordan Lee can give you more access if you need it.')).toBeTruthy();
    expect(screen.getByText('We’ve emailed you a note about how you’ll sign in next time.')).toBeTruthy();
    expect(root().querySelector('[data-auth-kit-slot="footer"]')!.textContent).toBe('This site is managed by the NC Office of State Budget and Management');
    // A password isn't a passkey: no hint.
    expect(await hasPasskeyHint('ada@osbm.example.org')).toBe(false);
  });

  it('an address that already had an account just signs in', async () => {
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({ next: '/reports' }, { configured: ['PASSWORD', 'EMAIL_OTP'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    await submitEmail(user);
    await user.type(await screen.findByLabelText('8-digit code'), '12345678{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports'));
    expect(screen.queryByRole('heading', { name: 'Your name' })).toBeNull();
    expect(auth.updateUserAttributes).not.toHaveBeenCalled();
  });

  it('…and one with a password but no authenticator sets that up first', async () => {
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    const { user, navigate } = setup({}, { configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] });
    await submitEmail(user);
    await user.type(await screen.findByLabelText('8-digit code'), '12345678{Enter}');
    await heading('Add an authenticator app');
    expect(navigate).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('an expired sign-in session says so with the lifetime, and "Start again" returns to the email', async () => {
    auth.confirmSignIn.mockRejectedValue(awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.'));
    const { user } = setup({ codeLifetimeMinutes: 10 });
    await submitEmail(user);
    await user.type(await screen.findByLabelText('8-digit code'), '12345678{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.'));
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    await heading('Create your account');
  });

  it('"Use a different email address" goes back', async () => {
    const { user } = setup();
    await submitEmail(user);
    await heading('Check your email');
    await user.click(screen.getByRole('button', { name: 'Use a different email address' }));
    await heading('Create your account');
    expect(within(root()).getByLabelText<HTMLInputElement>('Email address').value).toBe('ada@example.org');
  });
});
