// @vitest-environment jsdom
/**
 * Link and navigation props (I6): each ends up in an `href` or `window.location.assign`, where a
 * `javascript:` URL would run. A same-site path or an http(s) URL renders; anything else is the site's
 * misconfiguration and throws at render, naming the prop.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedHref, hrefOr } from '../../src/client/href.js';
import { MyAccount, type MyAccountProps, RequestAccess, type RequestAccessProps, SignIn, type SignInProps, SignedOutEverywhere, SignUp, type SignUpProps } from '../../src/client/index.js';
import { auth, resetAmplifyMocks } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const HELP = { address: 'apps-help@example.org' };
const JS = 'javascript:alert(document.cookie)';

// No network from tests: anything that reaches the real fetch (Cognito's endpoint, a route) fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  resetAmplifyMocks();
  vi.stubGlobal('fetch', noNetwork);
  // React logs the render error it rethrows; the assertion is the throw itself.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
});

const signIn = (props: Partial<SignInProps>) => render(createElement(SignIn, { siteName: 'Example Reports', help: HELP, passkeysEnabled: true, navigate: vi.fn(), loadFactors: vi.fn(), ...props }));
const signUp = (props: Partial<SignUpProps>) =>
  render(createElement(SignUp, { siteName: 'Example Reports', help: HELP, accountCreation: { mode: 'open' }, privacyNoticeUrl: '/privacy', passkeysEnabled: true, navigate: vi.fn(), fetch: vi.fn(), ...props }));
const requestAccess = (props: Partial<RequestAccessProps>) => render(createElement(RequestAccess, { siteName: 'Example Reports', help: HELP, navigate: vi.fn(), fetch: vi.fn(), ...props }));
const myAccount = (props: Partial<MyAccountProps>) =>
  render(createElement(MyAccount, { passkeysEnabled: false, issuer: 'Example Reports', navigate: vi.fn(), loadFactors: () => Promise.resolve({ configured: ['WEB_AUTHN'], mfa: [] }), ...props }));

describe('checkedHref', () => {
  it('accepts a same-site path or an absolute http(s) URL', () => {
    for (const ok of ['/', '/sign-up', '/account?reauth=1#top', 'https://example.org/privacy', 'http://localhost:3000/terms', 'HTTPS://Example.org']) {
      expect(checkedHref('signUpHref', ok, '/sign-up'), ok).toBe(ok);
    }
  });

  it('throws a developer error naming the prop for anything else', () => {
    const bad = [
      JS,
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example/sign-up',
      '/\\evil.example',
      '/\t/evil.example',
      'sign-up',
      '',
      'https://',
      'mailto:help@example.org',
    ];
    for (const value of bad) expect(() => checkedHref('signUpHref', value, '/sign-up'), JSON.stringify(value)).toThrow('auth-kit: signUpHref must be a path like /sign-up or an http(s) URL.');
  });

  it('hrefOr uses the default when the prop is missing, and checks one that’s given', () => {
    expect(hrefOr('signInHref', undefined, '/sign-in')).toBe('/sign-in');
    expect(hrefOr('signInHref', '/login', '/sign-in')).toBe('/login');
    expect(() => hrefOr('signInHref', JS, '/sign-in')).toThrow('auth-kit: signInHref must be a path like /sign-in or an http(s) URL.');
  });
});

describe('the screens refuse a javascript: link prop and render a normal one', () => {
  it('SignIn: signUpHref and requestAccessHref', () => {
    expect(() => signIn({ signUpHref: JS })).toThrow('auth-kit: signUpHref must be a path like /sign-up or an http(s) URL.');
    cleanup();
    expect(() => signIn({ requestAccessHref: JS })).toThrow('auth-kit: requestAccessHref must be a path like /request-access or an http(s) URL.');
    cleanup();
    signIn({ accountCreation: { mode: 'open' }, signUpHref: '/join' });
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/join');
    cleanup();
    signIn({ accountCreation: { mode: 'request' }, requestAccessHref: 'https://example.org/ask' });
    expect(screen.getByRole('link', { name: 'Request access' }).getAttribute('href')).toBe('https://example.org/ask');
  });

  it('SignUp: privacyNoticeUrl, termsUrl, signInHref, and requestAccessHref', () => {
    const cases: [Partial<SignUpProps>, string][] = [
      [{ privacyNoticeUrl: JS }, 'auth-kit: privacyNoticeUrl must be a path like /privacy or an http(s) URL.'],
      [{ termsUrl: JS }, 'auth-kit: termsUrl must be a path like /terms or an http(s) URL.'],
      [{ signInHref: JS }, 'auth-kit: signInHref must be a path like /sign-in or an http(s) URL.'],
      [{ requestAccessHref: JS }, 'auth-kit: requestAccessHref must be a path like /request-access or an http(s) URL.'],
    ];
    for (const [props, message] of cases) {
      expect(() => signUp(props)).toThrow(message);
      cleanup();
    }
    signUp({ privacyNoticeUrl: 'https://example.org/privacy', termsUrl: '/terms', signInHref: '/login' });
    expect(screen.getByRole('link', { name: 'privacy notice' }).getAttribute('href')).toBe('https://example.org/privacy');
    expect(screen.getByRole('link', { name: 'terms' }).getAttribute('href')).toBe('/terms');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('RequestAccess: signInHref (a navigate target) and privacyNoticeUrl', async () => {
    expect(() => requestAccess({ signInHref: JS })).toThrow('auth-kit: signInHref must be a path like /sign-in or an http(s) URL.');
    cleanup();
    expect(() => requestAccess({ privacyNoticeUrl: JS })).toThrow('auth-kit: privacyNoticeUrl must be a path like /privacy or an http(s) URL.');
    cleanup();
    const navigate = vi.fn();
    requestAccess({ signInHref: '/login', privacyNoticeUrl: '/privacy', navigate });
    expect(screen.getByRole('link', { name: 'Privacy notice' }).getAttribute('href')).toBe('/privacy');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('SignedOutEverywhere: signInHref', () => {
    expect(() => render(createElement(SignedOutEverywhere, { siteName: 'Example Reports', signInHref: JS }))).toThrow('auth-kit: signInHref must be a path like /sign-in or an http(s) URL.');
    cleanup();
    render(createElement(SignedOutEverywhere, { siteName: 'Example Reports', signInHref: '/login' }));
    expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/login');
  });

  it('MyAccount: signedOutPath, deletedPath (navigate targets), and stepUpHref', async () => {
    const cases: [Partial<MyAccountProps>, string][] = [
      [{ signedOutPath: JS }, 'auth-kit: signedOutPath must be a path like /sign-in or an http(s) URL.'],
      [{ deletedPath: JS }, 'auth-kit: deletedPath must be a path like / or an http(s) URL.'],
      [{ stepUpHref: JS }, 'auth-kit: stepUpHref must be a path like /sign-in?reauth=1 or an http(s) URL.'],
    ];
    for (const [props, message] of cases) {
      expect(() => myAccount(props)).toThrow(message);
      cleanup();
    }
    const navigate = vi.fn();
    myAccount({ signedOutPath: '/goodbye', deletedPath: '/', stepUpHref: '/sign-in?next=%2Faccount&reauth=1', navigate });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    expect(auth.signOut).toHaveBeenCalledWith({ global: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/goodbye'));
  });
});
