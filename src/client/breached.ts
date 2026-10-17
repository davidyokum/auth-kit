/**
 * Breached-password check before saving a new password (03 §2: a Have I Been Pwned range check on
 * pools without Cognito's Plus plan; Plus doesn't check `ChangePassword` anyway).
 *
 * k-anonymity: only the first 5 hex characters of the password's SHA-1 leave the browser, and the
 * response is padded so its size doesn't hint at the prefix. The site's CSP needs
 * `connect-src https://api.pwnedpasswords.com`.
 */

export type BreachedPasswordCheck = (password: string) => Promise<boolean>;

export const PWNED_PASSWORDS_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * True when the password appears in Have I Been Pwned's breach corpus. Throws when the check can't
 * run (network, CSP); callers decide what that means (auth-kit's forms let the password through,
 * because the generated password a manager makes is the real protection).
 */
export async function isBreachedPassword(password: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const response = await fetcher(`${PWNED_PASSWORDS_RANGE_URL}${prefix}`, {
    headers: { 'Add-Padding': 'true' },
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`Pwned Passwords answered ${response.status}`);
  const body = await response.text();
  for (const line of body.split('\n')) {
    const [candidate, count] = line.trim().split(':');
    // Padding rows carry a count of 0.
    if (candidate === suffix && Number(count) > 0) return true;
  }
  return false;
}
