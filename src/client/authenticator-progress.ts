/**
 * An authenticator setup in progress, kept for this tab (sessionStorage) and keyed by the account's
 * `sub`, so a reload or a redirect shows the same setup key instead of asking Cognito for another.
 *
 * Each `setUpTOTP` (AssociateSoftwareToken) replaces the account's pending key, so a fresh one on every
 * mount silently broke an entry the person had just scanned: their app's codes then failed every time.
 * Now a new key comes only from "Get a new QR code", or once this record is older than `PROGRESS_TTL_MS`.
 *
 * `checked` records that the code checked out (`verifyTOTPSetup`) but the authenticator isn't on yet
 * (the held first password, or `updateMFAPreference`, didn't finish): the next setup screen finishes
 * the job without asking for another code.
 *
 * The key is no more exposed here than it already is: script on this origin can read the token cookies
 * and call `setUpTOTP` itself. It's removed as soon as the authenticator is on.
 */

export interface AuthenticatorProgress {
  /** The setup key on screen (base32). */
  readonly secret: string;
  /** The code checked out (`verifyTOTPSetup`); the authenticator isn't on yet. */
  readonly checked: boolean;
  /** When the key was issued (ms since the epoch). */
  readonly issuedAt: number;
}

/** A setup key kept longer than this is replaced on the next setup screen. */
export const PROGRESS_TTL_MS = 30 * 60_000;

const KEY = 'auth-kit:authenticator-setup:v1:';

// Where sessionStorage is refused (some private modes, a sandboxed frame): kept for this page only.
const memory = new Map<string, AuthenticatorProgress>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function valid(value: unknown, now: number): value is AuthenticatorProgress {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.secret === 'string' &&
    /^[A-Z2-7]{16,128}=*$/i.test(v.secret) &&
    typeof v.checked === 'boolean' &&
    typeof v.issuedAt === 'number' &&
    v.issuedAt <= now + 60_000 &&
    now - v.issuedAt < PROGRESS_TTL_MS
  );
}

/** The setup in progress for this account in this tab, or null (none, expired, or unreadable). */
export function readAuthenticatorProgress(userId: string, now: number = Date.now()): AuthenticatorProgress | null {
  const store = storage();
  let found: unknown;
  if (store) {
    try {
      const raw = store.getItem(KEY + userId);
      found = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      found = memory.get(userId) ?? null; // refused on read: the in-page copy
    }
  } else {
    found = memory.get(userId) ?? null;
  }
  if (valid(found, now)) return { secret: found.secret, checked: found.checked, issuedAt: found.issuedAt };
  clearAuthenticatorProgress(userId);
  return null;
}

export function saveAuthenticatorProgress(userId: string, progress: AuthenticatorProgress): void {
  memory.set(userId, progress);
  try {
    storage()?.setItem(KEY + userId, JSON.stringify(progress));
  } catch {
    // Full or refused: the in-page copy still covers a remount.
  }
}

export function clearAuthenticatorProgress(userId: string): void {
  memory.delete(userId);
  try {
    storage()?.removeItem(KEY + userId);
  } catch {
    // Nothing to remove.
  }
}
