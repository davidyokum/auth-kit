// @vitest-environment jsdom
/**
 * Preview mode (ADR 0025): every screen and state draws the real component, held where the spec says,
 * and nothing on it does anything but report: no Amplify call, no fetch, no storage write, no
 * credential or clipboard request, no navigation, no change of screen.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERRORS, FIRST_VISIT, SIGN_IN } from '../../src/client/copy.js';
import { SignIn } from '../../src/client/SignIn.js';
import {
  AuthKitPreview,
  PREVIEW_ACTIONS,
  PREVIEW_MARKER,
  PREVIEW_SCREENS,
  PreviewSpecError,
  type PreviewActionInfo,
  type PreviewSpec,
  resolvePreviewSpec,
} from '../../src/preview/index.js';
import { CARD_STYLES, THEME_FAMILIES } from '../../src/themes/index.js';
import { auth, resetAmplifyMocks } from '../client/amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('../client/amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('../client/amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('../client/amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('../client/amplify-mock.js')).utilsModule);

const ALL = PREVIEW_SCREENS.flatMap((s) => s.states.map((st) => ({ screen: s.id, state: st.id })));

function draw(spec: PreviewSpec) {
  const onAction = vi.fn<(name: string, info: PreviewActionInfo) => void>();
  const onEffect = vi.fn<(name: string) => void>();
  const view = render(createElement(AuthKitPreview, { spec: { ...spec, onAction, onEffect } }));
  const stage = view.container.querySelector<HTMLElement>('[data-auth-kit-preview]')!;
  return { ...view, stage, onAction, onEffect };
}

/** Where the card is: its root's view, and the chooser's stage when it's showing. */
function whereIs(stage: Element): string {
  const root = stage.querySelector('[data-auth-kit]');
  const chooser = stage.querySelector('[data-auth-kit="choose-first-credential"]');
  return [root?.getAttribute('data-auth-kit'), root?.getAttribute('data-auth-kit-view'), chooser?.getAttribute('data-auth-kit-view')].join('/');
}

/** Every control a person can use on the card: buttons and links (not a field's own Show, not the summary's links to fields), and forms. */
function controls(stage: Element): Element[] {
  return [...stage.querySelectorAll('button, a[href], form')].filter((el) => {
    if (el instanceof HTMLButtonElement) return el.type !== 'submit' && el.getAttribute('data-auth-kit-slot') !== 'showButton' && !el.disabled;
    if (el instanceof HTMLAnchorElement) return !el.getAttribute('href')!.startsWith('#');
    // A form reports through its submit (its submit button submits it); one with no button has nothing to submit.
    return el.querySelector('button[type="submit"]') !== null;
  });
}

let spies: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetAmplifyMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  spies = {
    fetch: vi.fn(() => Promise.reject(new Error('no fetch in a preview'))),
    credentialsGet: vi.fn(() => Promise.reject(new Error('no credentials in a preview'))),
    credentialsCreate: vi.fn(() => Promise.reject(new Error('no credentials in a preview'))),
    clipboard: vi.fn(() => Promise.resolve()),
    open: vi.fn(),
    consoleError: vi.fn(),
  };
  vi.stubGlobal('fetch', spies.fetch);
  vi.stubGlobal('open', spies.open);
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: spies.credentialsGet, create: spies.credentialsCreate } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: spies.clipboard } });
  vi.spyOn(console, 'error').mockImplementation(spies.consoleError as () => void);
  for (const store of [window.localStorage, window.sessionStorage]) {
    vi.spyOn(Object.getPrototypeOf(store) as Storage, 'setItem');
    vi.spyOn(Object.getPrototypeOf(store) as Storage, 'removeItem');
    vi.spyOn(Object.getPrototypeOf(store) as Storage, 'clear');
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectNothingHappened(onEffect: ReturnType<typeof vi.fn>) {
  expect(onEffect).not.toHaveBeenCalled();
  for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  for (const [name, mock] of Object.entries(auth)) expect(mock, `aws-amplify/auth ${name}`).not.toHaveBeenCalled();
  const proto = Object.getPrototypeOf(window.localStorage) as Storage;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the spies, read back
  for (const method of [proto.setItem, proto.removeItem, proto.clear]) expect(method).not.toHaveBeenCalled();
}

describe('every screen and state draws the real card, held', () => {
  it('has a list of screens with unique IDs, states, and a default for each', () => {
    expect(new Set(PREVIEW_SCREENS.map((s) => s.id)).size).toBe(PREVIEW_SCREENS.length);
    for (const s of PREVIEW_SCREENS) {
      expect(s.states.length, s.id).toBeGreaterThan(0);
      expect(new Set(s.states.map((st) => st.id)).size, s.id).toBe(s.states.length);
    }
    // The Sign-in Studio's screen table names these { screen, state } pairs (register E9).
    const studio = [
      ['email', ''], ['choose', ''], ['passkey', ''], ['password', ''], ['totp', ''], ['email-code', ''], ['email-code', 'resent'],
      ['first-credential', ''], ['create-passkey', ''], ['create-password', ''], ['totp-setup', ''], ['done', 'passkey'], ['done', 'password'],
      ['access-help', ''], ['request-access', ''], ['request-access', 'missing'], ['request-access', 'sent'], ['sign-up', ''], ['sign-up', 'not-allowed'],
      ['sign-up-code', ''], ['sign-up-name', 'finish'], ['sign-up-name', 'create-account'], ['done', 'new-account'],
      ['email', 'empty'], ['email', 'invalid'], ['passkey', 'cancelled'], ['password', 'wrong'], ['totp', 'wrong'], ['email-code', 'wrong'], ['email-code', 'expired'],
      ['email', 'throttled'], ['email', 'offline'], ['create-passkey', 'failed'], ['create-password', 'too-short'],
      ['trouble', ''], ['help', 'passkey'], ['help', 'password'], ['help', 'totp'], ['help', 'code'], ['help', 'email'], ['help', 'else'],
      ['reset-code', ''], ['reset-password', ''], ['signed-out', ''],
    ] as const;
    for (const [screen, state] of studio) expect(() => resolvePreviewSpec({ screen, state }), `${screen}/${state}`).not.toThrow();
  });

  it.each(ALL)('$screen/$state: one real component, its heading, the stage marked, nothing happened', ({ screen, state }) => {
    const { stage, onEffect } = draw({ screen, state, family: 'osbm' });
    expect(stage.getAttribute('data-auth-kit-preview')).toBe(PREVIEW_MARKER);
    expect(stage.getAttribute('data-auth-kit-preview-screen')).toBe(screen);
    expect(stage.querySelectorAll('[data-auth-kit]:not([data-auth-kit] [data-auth-kit])')).toHaveLength(1);
    expect(stage.querySelector('[data-auth-kit-slot="heading"]')?.textContent).toBeTruthy();
    expect(stage.querySelector('[data-backdrop-card]')).not.toBeNull();
    // A held screen takes no focus: it's drawn among other things on a host's page.
    expect(document.activeElement).toBe(document.body);
    expectNothingHappened(onEffect);
  });

  it('draws every family and card style', () => {
    for (const family of THEME_FAMILIES) {
      for (const cardStyle of CARD_STYLES) {
        const { stage, unmount } = draw({ screen: 'choose', family, cardStyle });
        const root = stage.querySelector('[data-auth-kit="sign-in"]')!;
        expect(root.getAttribute('data-auth-kit-family')).toBe(family);
        expect(root.getAttribute('data-auth-kit-style')).toBe(cardStyle);
        unmount();
      }
    }
  });

  it('draws the states with the live words: the field checks and Cognito’s errors through describeAuthError', () => {
    const text = (spec: PreviewSpec) => {
      const { stage, unmount } = draw(spec);
      const t = stage.textContent ?? '';
      unmount();
      return t;
    };
    expect(text({ screen: 'email', state: 'empty' })).toContain(ERRORS.emptyEmail);
    expect(text({ screen: 'email', state: 'invalid', family: 'unc' })).toContain(ERRORS.badEmail('name@unc.edu'));
    expect(text({ screen: 'email', state: 'throttled' })).toContain(ERRORS.rateLimited);
    expect(text({ screen: 'email', state: 'offline', help: { address: 'help@example.org' } })).toContain('If it keeps happening, email help@example.org.');
    expect(text({ screen: 'password', state: 'wrong' })).toContain(ERRORS.wrongPassword);
    expect(text({ screen: 'totp', state: 'wrong' })).toContain(ERRORS.wrongTotp);
    expect(text({ screen: 'email-code', state: 'wrong' })).toContain(ERRORS.wrongEmailCode({ siteName: 'Example Reports' }));
    expect(text({ screen: 'email-code', state: 'expired' })).toContain(ERRORS.sessionExpired({ codeLifetimeMinutes: 10 }));
    expect(text({ screen: 'email-code', state: 'resent' })).toContain(SIGN_IN.codeResent('10:42 AM'));
    expect(text({ screen: 'passkey', state: 'cancelled' })).toContain(ERRORS.passkeyCancelled);
    expect(text({ screen: 'create-passkey', state: 'failed' })).toContain(ERRORS.passkeyCreateFailed);
    expect(text({ screen: 'create-password', state: 'too-short' })).toContain('Choose a password with at least 15 characters');
    expect(text({ screen: 'done', state: 'password' })).toContain(FIRST_VISIT.donePassword);
    expect(text({ screen: 'email', state: 'reauth' })).toContain(SIGN_IN.reauthHeading);
    expect(text({ screen: 'sign-up', state: 'not-allowed' })).toContain('Example Reports accounts are for example.org addresses.');
  });

  it('follows the site: name, help address, owner (families that name owners), account creation, the invite line', () => {
    const { stage } = draw({ screen: 'help', state: 'else', family: 'osbm', site: { name: 'Budget Tool', domain: 'budget.example.org' }, help: { address: 'budget-help@example.org', owner: 'Sam Rivera' } });
    expect(stage.textContent).toContain('Need help with your Budget Tool account?');
    expect(stage.textContent).toContain('budget-help@example.org');
    expect(stage.textContent).toContain('Sam Rivera looks after Budget Tool.');
    cleanup();
    expect(draw({ screen: 'email', accountCreation: 'request' }).stage.textContent).toContain('Request access');
    cleanup();
    expect(draw({ screen: 'email', accountCreation: 'domains', site: { domain: 'agency.example.gov' } }).stage.textContent).toContain('with your agency.example.gov email address.');
    cleanup();
    expect(draw({ screen: 'email', inviteLine: 'sentence' }).stage.textContent).toContain('Ask the person who runs it to add you.');
    cleanup();
    const open = draw({ screen: 'sign-up', accountCreation: 'open' }).stage;
    expect(open.querySelector('[data-auth-kit-action="terms"]')).not.toBeNull();
    expect(open.textContent).toContain('Protected against automated sign-ups.');
  });

  it('draws the stand-in QR code only when asked (sites pass renderQrCode), and says it encodes nothing', () => {
    const withQr = draw({ screen: 'totp-setup' }).stage;
    expect(withQr.querySelector('[data-auth-kit-preview-qr]')?.getAttribute('aria-label')).toMatch(/sample QR code \(it encodes nothing\)/);
    expect(withQr.textContent).toContain(FIRST_VISIT.cantScan);
    cleanup();
    const without = draw({ screen: 'totp-setup', qrCode: false }).stage;
    expect(without.querySelector('[data-auth-kit-preview-qr]')).toBeNull();
    expect(without.textContent).toContain(FIRST_VISIT.addTotpSubNoQr);
  });

  it('marks the stage for the device, the page theme, and the ground', () => {
    const { stage } = draw({ screen: 'email', device: 'phone', theme: 'dark', ground: true, family: 'unc' });
    expect(stage.getAttribute('data-auth-kit-device')).toBe('phone');
    expect(stage.getAttribute('data-auth-kit-preview-theme')).toBe('dark');
    expect(stage.hasAttribute('data-auth-kit-preview-ground')).toBe(true);
    expect(stage.style.getPropertyValue('--ak-preview-ground')).toBe('#13294b');
    expect(document.head.querySelector('style[data-auth-kit-preview-styles]')?.textContent).toContain('[data-auth-kit-device="phone"]');
  });
});

describe('inert: every control reports, and nothing else happens', () => {
  it.each(ALL)('$screen/$state', ({ screen, state }) => {
    const { stage, onAction, onEffect } = draw({ screen, state, family: 'osbm', accountCreation: screen === 'request-access' ? 'request' : 'invite' });
    const before = whereIs(stage);
    const heading = stage.querySelector('[data-auth-kit-slot="heading"]')?.textContent;
    const used = controls(stage);
    for (const control of used) {
      // Each is named in the markup (preview only), with a name from the stable list.
      const name = control.getAttribute('data-auth-kit-action');
      expect(name, control.outerHTML.slice(0, 120)).toBeTruthy();
      expect(PREVIEW_ACTIONS).toContain(name);
      const calls = onAction.mock.calls.length;
      if (control instanceof HTMLFormElement) fireEvent.submit(control);
      else fireEvent.click(control);
      expect(onAction.mock.calls.length, name!).toBe(calls + 1);
      const [reported, info] = onAction.mock.calls.at(-1)!;
      expect(reported).toBe(name);
      expect(info).toMatchObject({ screen, state: resolvePreviewSpec({ screen, state }).state });
    }
    // Still where it was: the same view, the same heading.
    expect(whereIs(stage)).toBe(before);
    expect(stage.querySelector('[data-auth-kit-slot="heading"]')?.textContent).toBe(heading);
    expectNothingHappened(onEffect);
  });

  it('typing works (the card’s own state), and onAction carries the values, never a password', async () => {
    const user = userEvent.setup();
    const { stage, onAction, getByLabelText, getByRole } = draw({ screen: 'email' });
    await user.type(getByLabelText('Email address'), 'grace@example.org');
    await user.click(getByRole('button', { name: 'Continue' }));
    expect(onAction).toHaveBeenLastCalledWith('continue', expect.objectContaining({ values: { username: 'grace@example.org' }, next: { screen: 'choose' }, label: 'Continue' }));
    expect(whereIs(stage)).toBe('sign-in/email/');
    cleanup();
    const pw = draw({ screen: 'password' });
    await user.type(pw.getByLabelText('Password'), 'hunter2-hunter2');
    await user.click(pw.getByRole('button', { name: 'Continue' }));
    expect(pw.onAction.mock.calls.at(-1)![1].values).not.toHaveProperty('current-password');
    expect(JSON.stringify(pw.onAction.mock.calls)).not.toContain('hunter2');
  });

  it('Show on a password field works locally and reports nothing', async () => {
    const user = userEvent.setup();
    const { getByLabelText, getByRole, onAction } = draw({ screen: 'password', state: 'wrong' });
    expect(getByLabelText('Password')).toHaveProperty('type', 'password');
    await user.click(getByRole('button', { name: /^Show ?password$/ }));
    expect(getByLabelText('Password')).toHaveProperty('type', 'text');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('says where the live card goes next', () => {
    const next = (spec: PreviewSpec, name: string) => {
      const { stage, onAction, unmount } = draw(spec);
      const control = stage.querySelector(`[data-auth-kit-action="${name}"]`)!;
      if (control instanceof HTMLFormElement) fireEvent.submit(control);
      else fireEvent.click(control);
      unmount();
      return onAction.mock.calls.at(-1)![1].next;
    };
    expect(next({ screen: 'email' }, 'continue')).toEqual({ screen: 'choose' });
    expect(next({ screen: 'email', remembered: true }, 'continue')).toEqual({ screen: 'passkey' });
    expect(next({ screen: 'email', passkeysEnabled: false }, 'continue')).toEqual({ screen: 'password' });
    expect(next({ screen: 'password' }, 'submit-password')).toEqual({ screen: 'totp' });
    expect(next({ screen: 'totp' }, 'submit-totp')).toEqual({ screen: '@signed-in' });
    expect(next({ screen: 'trouble' }, 'help-code')).toEqual({ screen: 'help', state: 'code' });
    expect(next({ screen: 'help', state: 'else' }, 'email-help')).toEqual({ screen: '@mail' });
    expect(next({ screen: 'request-access' }, 'send-request')).toEqual({ screen: 'request-access', state: 'sent' });
    expect(next({ screen: 'totp-setup' }, 'copy-setup-key')).toBeNull();
  });

  it('a live card has no action names in its markup (the live DOM is unchanged)', () => {
    const { container } = render(createElement(SignIn, { siteName: 'Example Reports', help: { address: 'help@example.org' }, passkeysEnabled: true }));
    expect(container.querySelectorAll('[data-auth-kit-action]')).toHaveLength(0);
    expect(container.querySelector('[data-auth-kit-preview]')).toBeNull();
  });
});

describe('the spec', () => {
  it('fills in the sample defaults', () => {
    const r = resolvePreviewSpec({});
    expect(r).toMatchObject({ screen: 'email', state: '', family: 'personal', theme: 'light', cardStyle: 'quiet', cardEdge: 'defined', siteName: 'Example Reports', email: 'ada@example.org', device: 'desktop' });
    expect(r.help.address).toBe('help@yokum.app');
    expect(resolvePreviewSpec({ family: 'osbm' }).help).toEqual({ address: 'help@example.org', owner: 'Jordan Lee' });
    expect(resolvePreviewSpec({ screen: 'done' }).state).toBe('passkey');
    expect(resolvePreviewSpec({ screen: 'help', state: '' }).state).toBe('passkey');
  });

  it('refuses what it can’t draw, and says what it can', () => {
    expect(() => resolvePreviewSpec({ screen: 'nope' })).toThrow(PreviewSpecError);
    expect(() => resolvePreviewSpec({ screen: 'nope' })).toThrow(/Screens: email, choose, passkey/);
    expect(() => resolvePreviewSpec({ screen: 'password', state: 'nope' })).toThrow(/States: '' \(the default\), wrong/);
    expect(() => resolvePreviewSpec({ family: 'acme' as never })).toThrow(/family must be one of osbm, unc, personal/);
    expect(() => resolvePreviewSpec({ cardStyle: 'glass' as never })).toThrow(/cardStyle must be one of quiet, monogram, frosted, plain, porcelain/);
    expect(() => resolvePreviewSpec({ accountCreation: 'anyone' as never })).toThrow(/accountCreation must be one of invite, request, domains, open/);
    expect(() => resolvePreviewSpec({ site: { domain: 'not a domain' } })).toThrow(/site\.domain/);
    expect(() => resolvePreviewSpec({ sampleUser: { email: 'nope' } })).toThrow(/sampleUser\.email/);
  });
});
