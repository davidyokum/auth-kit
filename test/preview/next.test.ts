// @vitest-environment jsdom
/**
 * The preview's "where the live card goes next" (`onAction`'s `info.next`, `nextAfter`) against the live
 * card: each screen is drawn with the real component held at its state by a LIVE driver (Amplify mocked
 * to succeed), each control is used as a person would, and the live card must land where the preview
 * says. Links and page navigations (which leave the card) are checked by where they point.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CognitoModule from '../../src/client/cognito.js';
import { FIRST_VISIT, helpScreen } from '../../src/client/copy.js';
import { type ClientDriver, DriverContext, LIVE_DRIVER } from '../../src/client/driver.js';
import { rememberPasskey } from '../../src/client/passkey-hint.js';
import { AuthKitPreview, nextAfter, placementOf, type PreviewSpec, resolvePreviewSpec } from '../../src/preview/index.js';
import { PreviewCard } from '../../src/preview/Preview.js';
import { auth, next as nextStep, resetAmplifyMocks, SIGNED_IN } from '../client/amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('../client/amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('../client/amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('../client/amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('../client/amplify-mock.js')).utilsModule);
const changePasswordWithoutPrevious = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../src/client/cognito.js', async (importOriginal) => ({ ...(await importOriginal<typeof CognitoModule>()), changePasswordWithoutPrevious }));

const pending = () => new Promise<never>(() => undefined);

beforeEach(() => {
  resetAmplifyMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Amplify answers each request the way a successful one does; a passkey window stays open.
  auth.signIn.mockImplementation((input: { options?: { preferredChallenge?: string } }) => {
    const challenge = input.options?.preferredChallenge;
    if (challenge === 'PASSWORD') return Promise.resolve(nextStep({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    if (challenge === 'EMAIL_OTP') return Promise.resolve(nextStep({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } }));
    return pending();
  });
  auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
  auth.associateWebAuthnCredential.mockImplementation(pending);
  // The site's routes (sign-up, request access, notices, GetUserAuthFactors): all say yes.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ ok: true }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Where a live card is, in the preview's words. */
function liveAt(container: Element): { screen: string; state: string } {
  const root = container.querySelector('[data-auth-kit]')!;
  const kind = root.getAttribute('data-auth-kit');
  const view = root.getAttribute('data-auth-kit-view') ?? '';
  const stage = container.querySelector('[data-auth-kit="choose-first-credential"]')?.getAttribute('data-auth-kit-view');
  const chooser = { choose: 'first-credential', 'create-passkey': 'create-passkey', 'create-password': 'create-password', 'add-totp': 'totp-setup' } as Record<string, string>;
  if (stage) return { screen: chooser[stage]!, state: '' };
  if (kind === 'request-access') return { screen: 'request-access', state: view === 'sent' ? 'sent' : '' };
  if (kind === 'sign-up') return view === 'done' ? { screen: 'done', state: 'new-account' } : { screen: ({ email: 'sign-up', code: 'sign-up-code', name: 'sign-up-name' } as Record<string, string>)[view] ?? view, state: '' };
  switch (view) {
    case 'help': {
      const heading = container.querySelector('[data-auth-kit-slot="heading"]')?.textContent;
      const c = { siteName: 'Example Reports', theme: resolvePreviewSpec({}).authTheme, codeLifetimeMinutes: 10, helpAddress: 'x@example.org' };
      return { screen: 'help', state: (['passkey', 'password', 'totp', 'code', 'email', 'else'] as const).find((t) => helpScreen(t, c).heading === heading) ?? '?' };
    }
    case 'email-code':
      return { screen: 'email-code', state: container.querySelector('[data-auth-kit-slot="note"]') ? 'resent' : '' };
    case 'email':
      return { screen: 'email', state: container.querySelector<HTMLInputElement>('input[name="username"]')?.value ? 'typed' : '' };
    case 'totp-setup':
      return { screen: 'mfa-setup', state: '' };
    case 'done':
      return { screen: 'done', state: container.textContent?.includes(FIRST_VISIT.donePassword) ? 'password' : 'passkey' };
    default:
      return { screen: view, state: '' };
  }
}

/** Types what a person would into every empty visible field. */
function fill(container: Element): void {
  for (const field of container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name]:not([hidden]), textarea[name]')) {
    if (field.value !== '' || field.readOnly) continue;
    const label = field.labels?.[0]?.textContent ?? '';
    const value =
      field.name === 'username' || field.name === 'email'
        ? 'ada@example.org'
        : field.name.endsWith('password')
          ? 'correct-horse-battery-staple'
          : field.name === 'one-time-code'
            ? label.startsWith('8') ? '12345678' : '123456'
            : field.name === 'name'
              ? 'Ada Lovelace'
              : field.name === 'given-name'
                ? 'Ada'
                : field.name === 'family-name'
                  ? 'Lovelace'
                  : '';
    if (value) fireEvent.change(field, { target: { value } });
  }
}

/** The controls a person can use, in document order (the same order in a preview and a live card). */
function controls(container: Element): Element[] {
  return [...container.querySelectorAll('button, a[href], form')].filter((el) =>
    el instanceof HTMLButtonElement ? el.type !== 'submit' && el.getAttribute('data-auth-kit-slot') !== 'showButton' : el instanceof HTMLAnchorElement ? !el.getAttribute('href')!.startsWith('#') : el.querySelector('button[type="submit"]') !== null,
  );
}

const CASES: PreviewSpec[] = [
  { screen: 'email', state: 'typed' },
  { screen: 'email', state: 'typed', remembered: true },
  { screen: 'email', state: 'typed', accountCreation: 'request' },
  { screen: 'email', state: 'typed', accountCreation: 'domains' },
  { screen: 'choose' },
  { screen: 'passkey' },
  { screen: 'passkey', remembered: true },
  { screen: 'password', state: 'wrong' },
  { screen: 'totp' },
  { screen: 'email-code' },
  { screen: 'email-code', state: 'expired' },
  { screen: 'first-credential' },
  // The live card's other ways in work once the browser's passkey window has closed (here: cancelled).
  { screen: 'create-passkey', state: 'failed' },
  { screen: 'create-password' },
  { screen: 'totp-setup' },
  { screen: 'access-help' },
  { screen: 'request-access' },
  { screen: 'sign-up' },
  { screen: 'sign-up-code' },
  { screen: 'sign-up-name' },
  { screen: 'trouble' },
  ...(['passkey', 'password', 'totp', 'code', 'email', 'else'] as const).map((state) => ({ screen: 'help', state })),
  { screen: 'reset-code' },
  { screen: 'reset-password' },
  { screen: 'signed-out' },
];

/** Where a link points or a page navigation goes, for each target outside the card. */
const PAGES: Record<string, string> = { '/sign-in': 'email', '/sign-up': 'sign-up', '/request-access': 'request-access' };

describe('where the live card goes next', () => {
  it.each(CASES.map((spec) => ({ ...spec, label: `${spec.screen}/${spec.state ?? ''}${spec.remembered ? ' (remembered)' : ''}${typeof spec.accountCreation === 'string' ? ` (${spec.accountCreation})` : ''}` })))('$label', async (spec) => {
    const r = resolvePreviewSpec(spec);
    // The preview names each control; the live card has the same controls in the same order.
    const preview = render(createElement(AuthKitPreview, { spec }));
    const named = controls(preview.container).map((el) => el.getAttribute('data-auth-kit-action')!);
    preview.unmount();
    expect(named.length).toBeGreaterThan(0);

    let checked = 0;
    for (const [index, name] of named.entries()) {
      const target = nextAfter(r, r.screen, name);
      if (target === null || target.screen === '@signed-in' || target.screen === '@mail') continue;
      if (spec.remembered) await rememberPasskey('ada@example.org');
      if (r.screen === 'create-passkey') auth.associateWebAuthnCredential.mockRejectedValue(Object.assign(new Error('canceled'), { name: 'PasskeyRegistrationCanceled' }));
      const navigate = vi.fn();
      const placement = placementOf(r);
      // The live driver, starting where the preview holds the card (but a setup key comes from Amplify, as live).
      const { 'authenticator-setup': _key, ...held } = placement.held;
      const driver: ClientDriver = { ...LIVE_DRIVER, initial: (c) => (held as typeof placement.held)[c], navigate };
      const live = render(createElement(DriverContext.Provider, { value: driver }, createElement(PreviewCard, { r, placement })));
      if (r.screen === 'totp-setup') await waitFor(() => expect(live.container.querySelector('input[name="one-time-code"]')).not.toBeNull());
      fill(live.container);
      const control = controls(live.container)[index]!;
      // A control disabled while a request is in flight (a passkey window opening on mount) is used once it's done.
      if (control instanceof HTMLButtonElement) await waitFor(() => expect(control.disabled, name).toBe(false));
      if (control instanceof HTMLAnchorElement) {
        const href = control.getAttribute('href')!;
        if (target.screen === '@link') expect(href, name).not.toMatch(/^(\/sign-in|\/sign-up|\/request-access)$/);
        else expect(PAGES[href], `${name} → ${href}`).toBe(target.screen);
      } else {
        if (control instanceof HTMLFormElement) fireEvent.submit(control);
        else fireEvent.click(control);
        if (navigate.mock.calls.length > 0 || target.screen === 'request-access' && r.screen !== 'request-access') {
          // A page navigation: the next page is the target screen.
          await waitFor(() => expect(navigate).toHaveBeenCalled());
          expect(PAGES[navigate.mock.calls[0]![0] as string], name).toBe(target.screen);
        } else {
          await waitFor(() => expect(liveAt(live.container).screen, `${r.screen}: ${name}`).toBe(target.screen));
          if (target.state !== undefined) expect(liveAt(live.container).state, `${r.screen}: ${name}`).toBe(target.state);
        }
      }
      checked++;
      live.unmount();
      window.localStorage.clear();
    }
    expect(checked, 'checked at least one action').toBeGreaterThan(0);
  });
});
