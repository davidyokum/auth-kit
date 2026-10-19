/**
 * The passkey hint (register A5a, 2026-10-19): which addresses this browser has signed in with a
 * passkey, so "Continue" opens the passkey prompt only where one is likely to be found, and goes to
 * "How do you want to sign in?" everywhere else (a first-time user no longer meets the browser's "no
 * passkey found").
 *
 * - Kept in this browser's `localStorage` for this site only, as salted SHA-256 hashes of the
 *   normalized addresses; the salt is a random per-browser value kept beside them. Never sent anywhere:
 *   the screens and the server traffic are the same for every address up to the person's choice
 *   (ADR 0018). It isn't a secret either: it only decides which screen shows first.
 * - Set after a passkey sign-in and after creating a passkey here. Removed when My account removes
 *   the account's last passkey, and when someone sent to the prompt by the hint chooses another way in
 *   twice in a row (that passkey isn't on this device any more).
 * - Every read and write is guarded: blocked storage, no `crypto.subtle`, or anything odd reads as "no
 *   hint", which only means the choice screen.
 */

const KEY = 'auth-kit:passkey-hint:v1';
/** At most this many addresses per browser (the oldest go first). */
const MAX_ADDRESSES = 20;
/** Choosing another way in this many times in a row, from the prompt the hint opened, forgets it. */
export const PASSKEY_HINT_SKIPS = 2;

interface HintState {
  salt: string;
  hashes: string[];
  skips: Record<string, number>;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(): HintState | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<HintState>;
      if (typeof v.salt === 'string' && v.salt.length >= 16 && Array.isArray(v.hashes)) {
        return { salt: v.salt, hashes: v.hashes.filter((h): h is string => typeof h === 'string').slice(-MAX_ADDRESSES), skips: v.skips && typeof v.skips === 'object' ? v.skips : {} };
      }
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return { salt: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), hashes: [], skips: {} };
  } catch {
    return null;
  }
}

function write(state: HintState): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Blocked or full storage: no hint, which only means the choice screen.
  }
}

async function hashOf(salt: string, email: string): Promise<string | null> {
  try {
    const data = new TextEncoder().encode(`${salt}:${email.trim().toLowerCase()}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** True when this browser remembers a passkey sign-in for the address. Never throws. */
export async function hasPasskeyHint(email: string): Promise<boolean> {
  const state = read();
  if (!state || state.hashes.length === 0) return false;
  const h = await hashOf(state.salt, email);
  return h !== null && state.hashes.includes(h);
}

/** Remembers a passkey for the address on this browser (after a passkey sign-in or creating one). Never throws. */
export async function rememberPasskey(email: string): Promise<void> {
  const state = read();
  if (!state) return;
  const h = await hashOf(state.salt, email);
  if (h === null) return;
  const hashes = [...state.hashes.filter((x) => x !== h), h].slice(-MAX_ADDRESSES);
  const { [h]: _cleared, ...skips } = state.skips;
  write({ salt: state.salt, hashes, skips });
}

/** Forgets the address. Never throws. */
export async function forgetPasskey(email: string): Promise<void> {
  const state = read();
  if (!state) return;
  const h = await hashOf(state.salt, email);
  if (h === null || !state.hashes.includes(h)) return;
  const { [h]: _cleared, ...skips } = state.skips;
  write({ salt: state.salt, hashes: state.hashes.filter((x) => x !== h), skips });
}

/**
 * Someone the hint sent to the passkey prompt chose another way in. The second time in a row, the
 * hint is forgotten (that passkey isn't on this device any more). Never throws.
 */
export async function passkeyHintSkipped(email: string): Promise<void> {
  const state = read();
  if (!state) return;
  const h = await hashOf(state.salt, email);
  if (h === null || !state.hashes.includes(h)) return;
  const n = (state.skips[h] ?? 0) + 1;
  if (n >= PASSKEY_HINT_SKIPS) await forgetPasskey(email);
  else write({ ...state, skips: { ...state.skips, [h]: n } });
}
