/**
 * The screens' driver (ADR 0025): the one seam between the sign-in screens and the world outside the
 * card. Every effect a screen has goes through it: Amplify's calls to Cognito, this browser's storage
 * (the passkey hint, the passkey offer, the request form's hand-off), the site's routes (notices, the
 * sign-up and request forms), the breached-password check, the clipboard, and navigation.
 *
 * The screens read it from React context. The default is the live driver below, which calls exactly
 * what the screens called before it existed, so a site using `auth-kit/client` sees no difference and
 * passes nothing. Preview mode (`auth-kit/preview`) provides another driver that:
 *
 * - holds a screen where it says (`held`, `initial`): each component starts in the state it's given
 *   (a view, the address typed, an error) instead of its first screen, and starts no ceremony on mount;
 * - makes every control report instead of act (`act`): a click or a submit calls the preview's
 *   `onAction(name)` and changes nothing;
 * - implements none of the effects: no network, no storage, no credentials, no clipboard, no navigation.
 *
 * Client code imports only its own files, `src/shared/`, the themes, React, and Amplify (hygiene test),
 * so this module lives here and the preview imports it, never the other way round.
 */
import { type SyntheticEvent, createContext, useContext } from 'react';
import type { AccountNoticeEvent } from '../shared/notices.js';
import {
  type AuthenticatorEnrollment,
  completeNewPassword,
  confirmCode,
  confirmPassword,
  confirmPasswordReset,
  currentUser,
  enrollAuthenticator,
  fetchAccountEmail,
  fetchAuthFactors,
  registerPasskey,
  requestEmailCode,
  requestPasswordReset,
  saveName,
  setFirstPassword,
  lastPasskeyAttachment,
  type PasskeyAttachment,
  signInWithPasskey,
  signInWithPassword,
} from './api.js';
import { type PostOutcome, handOffEmail, postAccountForm, takeHandedOffEmail } from './account-creation-client.js';
import type { BreachedPasswordCheck } from './breached.js';
import type { FirstCredentialStage } from './ChooseFirstCredential.js';
import type { ClientAuthFactors } from './ladder.js';
import { sendAccountNotice } from './notices.js';
import { type PasskeyPromptOptions, decoyPasskeyPrompt } from './parity.js';
import { hasPasskeyHint, passkeyHintSkipped, rememberPasskey } from './passkey-hint.js';
import { breachedPasswordProblem } from './PasswordForm.js';
import type { SignInView } from './SignIn.js';
import type { SignUpView } from './SignUp.js';
import type { SignInStep } from './steps.js';

/** Everything the screens do outside the card. The live driver calls the real thing; the preview's does nothing. */
export interface DriverEffects {
  readonly signInWithPasskey: (email: string) => Promise<SignInStep>;
  /** Where the last passkey sign-in's passkey lives (`null`: the browser didn't say). */
  readonly lastPasskeyAttachment: () => PasskeyAttachment | null;
  readonly signInWithPassword: (email: string, password: string) => Promise<SignInStep>;
  readonly requestEmailCode: (email: string) => Promise<SignInStep>;
  readonly confirmPassword: (password: string) => Promise<SignInStep>;
  readonly confirmCode: (code: string) => Promise<SignInStep>;
  readonly completeNewPassword: (password: string) => Promise<SignInStep>;
  readonly requestPasswordReset: (email: string) => Promise<{ destination?: string }>;
  readonly confirmPasswordReset: (email: string, code: string, newPassword: string) => Promise<void>;
  readonly currentUser: () => Promise<{ userId: string; loginId?: string } | null>;
  readonly fetchAuthFactors: () => Promise<ClientAuthFactors>;
  readonly registerPasskey: () => Promise<void>;
  readonly setFirstPassword: (password: string) => Promise<void>;
  readonly enrollAuthenticator: (input: { issuer: string; accountName?: string; deviceName?: string }) => Promise<AuthenticatorEnrollment>;
  readonly fetchAccountEmail: () => Promise<string | undefined>;
  readonly saveName: (input: { givenName: string; familyName: string }) => Promise<void>;
  /** The passkey window for an account with no passkey (ADR 0018): the browser's WebAuthn prompt. */
  readonly decoyPasskeyPrompt: (options?: PasskeyPromptOptions) => Promise<never>;
  /** The passkey hint (register A5a), in this browser's localStorage. */
  readonly hasPasskeyHint: (email: string) => Promise<boolean>;
  readonly rememberPasskey: (email: string) => Promise<void>;
  readonly passkeyHintSkipped: (email: string) => Promise<void>;
  /** "Create a passkey on this device?" was dismissed for this account here (localStorage). */
  readonly passkeyOfferDismissed: (userId: string | undefined) => boolean;
  readonly dismissPasskeyOffer: (userId: string | undefined) => void;
  /** Asks the site's notice route to email the account (register A10). */
  readonly sendAccountNotice: (notices: { url: string; fetch?: typeof fetch } | null, event: AccountNoticeEvent) => Promise<boolean>;
  /** Posts the sign-up or request form to the site's route. */
  readonly postAccountForm: (url: string, payload: Record<string, unknown>, options?: { fetch?: typeof fetch; helpAddress?: string; networkMessage?: string }) => Promise<PostOutcome>;
  /** "Ask for access instead" hands the typed address to the request form (sessionStorage). */
  readonly handOffEmail: (email: string) => void;
  readonly takeHandedOffEmail: () => string;
  readonly breachedPasswordProblem: (password: string, check: BreachedPasswordCheck | false | undefined) => Promise<string | null>;
  readonly writeClipboard: (text: string) => Promise<void>;
  /** A full page load, so the server sees the new cookies. A screen's own `navigate` prop wins. */
  readonly navigate: (path: string) => void;
}

/** The busy, error, and status state a held screen starts with (`useFeedback`'s state). */
export interface HeldFeedback {
  error?: string | null;
  status?: string | null;
  /** Which field the error is about. */
  field?: string | null;
  busy?: boolean;
}

/** A field problem on the request form. */
export interface HeldProblem {
  message: string;
  field: 'name' | 'email' | 'reason';
}

/** Where each component starts when a driver holds it (preview mode). Never set by the live driver. */
export interface HeldStates {
  'sign-in': { view: SignInView; email?: string; secret?: string; code?: string; resendReady?: boolean; feedback?: HeldFeedback };
  'choose-first-credential': { stage: FirstCredentialStage; passkeyFailed?: boolean; password?: string; feedback?: HeldFeedback };
  /** The setup key on screen, as if `setUpTOTP` had answered. */
  'authenticator-setup': { secret: string; code?: string; feedback?: HeldFeedback };
  'sign-up': { view: SignUpView; email?: string; code?: string; given?: string; family?: string; resendReady?: boolean; feedback?: HeldFeedback };
  'request-access': { sent?: boolean; name?: string; email?: string; reason?: string; problems?: readonly HeldProblem[]; feedback?: HeldFeedback };
}

export interface ClientDriver extends DriverEffects {
  /**
   * True in preview mode: the screen is held where `initial` puts it. Components start no ceremony on
   * mount (the passkey window, a setup key) and move no focus by themselves.
   */
  readonly held: boolean;
  /** The state a component starts in, when held; undefined in the live driver. */
  readonly initial: <K extends keyof HeldStates>(component: K) => HeldStates[K] | undefined;
  /**
   * A control's handler. Live: the handler itself, unchanged. Preview: a handler that reports `name`
   * (`onAction`) and does nothing else (a link's default is prevented). Without a handler (a plain
   * link): live returns undefined, so the link behaves as it always did.
   */
  readonly act: {
    (name: string): ((event: SyntheticEvent) => void) | undefined;
    <A extends unknown[]>(name: string, handler: (...args: A) => void): (...args: A) => void;
  };
}

// ---- The live driver ---------------------------------------------------------------------------

const OFFER_KEY = 'auth-kit:passkey-offer-dismissed:';

function liveAct(_name: string, handler?: (...args: never[]) => void): ((...args: never[]) => void) | undefined {
  return handler;
}

/**
 * Exactly what the screens did before the driver existed. Each member calls through at call time, so a
 * module a test mocks (`aws-amplify/auth`, `./cognito.js`) is the one that runs.
 */
export const LIVE_DRIVER: ClientDriver = Object.freeze({
  held: false,
  initial: () => undefined,
  act: liveAct as ClientDriver['act'],
  signInWithPasskey: (email: string) => signInWithPasskey(email),
  lastPasskeyAttachment: () => lastPasskeyAttachment(),
  signInWithPassword: (email: string, password: string) => signInWithPassword(email, password),
  requestEmailCode: (email: string) => requestEmailCode(email),
  confirmPassword: (password: string) => confirmPassword(password),
  confirmCode: (code: string) => confirmCode(code),
  completeNewPassword: (password: string) => completeNewPassword(password),
  requestPasswordReset: (email: string) => requestPasswordReset(email),
  confirmPasswordReset: (email: string, code: string, newPassword: string) => confirmPasswordReset(email, code, newPassword),
  currentUser: () => currentUser(),
  fetchAuthFactors: () => fetchAuthFactors(),
  registerPasskey: () => registerPasskey(),
  setFirstPassword: (password: string) => setFirstPassword(password),
  enrollAuthenticator: (input: { issuer: string; accountName?: string; deviceName?: string }) => enrollAuthenticator(input),
  fetchAccountEmail: () => fetchAccountEmail(),
  saveName: (input: { givenName: string; familyName: string }) => saveName(input),
  decoyPasskeyPrompt: (options?: PasskeyPromptOptions) => decoyPasskeyPrompt(options),
  hasPasskeyHint: (email: string) => hasPasskeyHint(email),
  rememberPasskey: (email: string) => rememberPasskey(email),
  passkeyHintSkipped: (email: string) => passkeyHintSkipped(email),
  passkeyOfferDismissed(userId: string | undefined): boolean {
    if (!userId) return false;
    try {
      return window.localStorage.getItem(OFFER_KEY + userId) === '1';
    } catch {
      return false;
    }
  },
  dismissPasskeyOffer(userId: string | undefined): void {
    if (!userId) return;
    try {
      window.localStorage.setItem(OFFER_KEY + userId, '1');
    } catch {
      // Private mode or blocked storage: the offer may show again next time.
    }
  },
  sendAccountNotice: (notices: { url: string; fetch?: typeof fetch } | null, event: AccountNoticeEvent) => sendAccountNotice(notices, event),
  postAccountForm: (url: string, payload: Record<string, unknown>, options?: { fetch?: typeof fetch; helpAddress?: string; networkMessage?: string }) => postAccountForm(url, payload, options),
  handOffEmail: (email: string) => handOffEmail(email),
  takeHandedOffEmail: () => takeHandedOffEmail(),
  breachedPasswordProblem: (password: string, check: BreachedPasswordCheck | false | undefined) => breachedPasswordProblem(password, check),
  writeClipboard(text: string): Promise<void> {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) return Promise.reject(new Error('No clipboard here.'));
    return clipboard.writeText(text);
  },
  navigate: (path: string) => window.location.assign(path),
});

/** The driver the screens use: the live one unless a preview provides another. Not exported from `auth-kit/client`. */
export const DriverContext = createContext<ClientDriver>(LIVE_DRIVER);

export function useDriver(): ClientDriver {
  return useContext(DriverContext);
}

// ---- Naming controls in the markup (preview only) ----------------------------------------------

const ACTION_NAMES = new WeakMap<object, string>();

/** Marks a preview handler with its action's name, so the markup can carry it (`tagged`). */
export function nameAction<F extends object>(handler: F, name: string): F {
  ACTION_NAMES.set(handler, name);
  return handler;
}

/** The action a handler reports, when a preview driver made it. */
export function actionOf(handler: unknown): string | undefined {
  return (typeof handler === 'function' && ACTION_NAMES.get(handler)) || undefined;
}

/**
 * `data-auth-kit-action="<name>"` for a control whose handler a preview driver made, so a host can list
 * a screen's actions; nothing for a live handler, so the live markup is unchanged.
 */
export function tagged(handler: unknown): { 'data-auth-kit-action'?: string } {
  const name = actionOf(handler);
  return name ? { 'data-auth-kit-action': name } : {};
}
