/**
 * The preview's driver (ADR 0025): holds the screens where the placement says, turns every control into
 * a report, and performs no effect. Nothing here touches the network, storage, credentials, the
 * clipboard, or navigation.
 */
import type { SyntheticEvent } from 'react';
import { type ClientDriver, type HeldStates, nameAction } from '../client/driver.js';
import type { SignInStep } from '../client/steps.js';

/** A promise that never settles: a request the preview never answers, so the screen stays as drawn. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function isEvent(value: unknown): value is SyntheticEvent {
  return typeof value === 'object' && value !== null && typeof (value as SyntheticEvent).preventDefault === 'function';
}

export interface PreviewDriverOptions {
  /** Where each component starts. */
  held: Partial<HeldStates>;
  /** The address the step-up prefill and setup screens use. */
  email: string;
  /** What `hasPasskeyHint` answers (register A5a). */
  remembered: boolean;
  /** A control was used: its action's name and the event (for the control and the card's values). */
  onAction: (name: string, event: SyntheticEvent | undefined) => void;
  /** A screen reached an effect the preview refuses. Never expected: every control reports first. */
  onEffect: (name: string) => void;
}

export function previewDriver(options: PreviewDriverOptions): ClientDriver {
  const { held, onAction, onEffect } = options;
  /** An effect the preview refuses: reported, and never answered. */
  const refused =
    <T,>(name: string) =>
    (): Promise<T> => {
      onEffect(name);
      return never<T>();
    };
  /** An effect the preview refuses that answers nothing (a write). */
  const ignored =
    (name: string) =>
    (): void => {
      onEffect(name);
    };

  function act(name: string, _handler?: (...args: never[]) => void): (event?: unknown) => void {
    const report = (event?: unknown) => {
      // A link's or a form's default (navigating, submitting) never happens either.
      if (isEvent(event)) event.preventDefault();
      onAction(name, isEvent(event) ? event : undefined);
    };
    return nameAction(report, name);
  }

  return Object.freeze({
    held: true,
    initial: <K extends keyof HeldStates>(component: K) => held[component],
    act: act as ClientDriver['act'],
    // Sign-in requests: never sent.
    signInWithPasskey: refused<SignInStep>('signInWithPasskey'),
    signInWithPassword: refused<SignInStep>('signInWithPassword'),
    requestEmailCode: refused<SignInStep>('requestEmailCode'),
    confirmPassword: refused<SignInStep>('confirmPassword'),
    confirmCode: refused<SignInStep>('confirmCode'),
    completeNewPassword: refused<SignInStep>('completeNewPassword'),
    requestPasswordReset: refused<{ destination?: string }>('requestPasswordReset'),
    confirmPasswordReset: refused<void>('confirmPasswordReset'),
    fetchAuthFactors: refused<never>('fetchAuthFactors'),
    registerPasskey: refused<void>('registerPasskey'),
    setFirstPassword: refused<void>('setFirstPassword'),
    enrollAuthenticator: refused<never>('enrollAuthenticator'),
    saveName: refused<void>('saveName'),
    decoyPasskeyPrompt: refused<never>('decoyPasskeyPrompt'),
    sendAccountNotice: refused<boolean>('sendAccountNotice'),
    postAccountForm: refused<never>('postAccountForm'),
    breachedPasswordProblem: refused<string | null>('breachedPasswordProblem'),
    writeClipboard: refused<void>('writeClipboard'),
    // Reads a held screen may make on mount: answered from the sample, touching nothing.
    currentUser: () => Promise.resolve({ userId: 'preview', loginId: options.email }),
    lastPasskeyAttachment: () => null,
    fetchAccountEmail: () => Promise.resolve(options.email),
    hasPasskeyHint: () => Promise.resolve(options.remembered),
    passkeyOfferDismissed: () => false,
    takeHandedOffEmail: () => '',
    // Writes: never made.
    rememberPasskey: () => {
      onEffect('rememberPasskey');
      return Promise.resolve();
    },
    passkeyHintSkipped: () => {
      onEffect('passkeyHintSkipped');
      return Promise.resolve();
    },
    dismissPasskeyOffer: ignored('dismissPasskeyOffer'),
    handOffEmail: ignored('handOffEmail'),
    navigate: ignored('navigate'),
  } satisfies ClientDriver);
}
