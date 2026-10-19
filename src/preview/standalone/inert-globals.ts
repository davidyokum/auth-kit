/**
 * The standalone preview bundle's second wall (ADR 0025). The build replaces every browser API the
 * card's code could use to reach outside the page (`fetch`, `localStorage`, `sessionStorage`,
 * `navigator.credentials`, `navigator.clipboard`, `location.assign`) with these, so even a control the
 * driver missed couldn't touch the network, storage, credentials, the clipboard, or navigation. Reads
 * find nothing; writes and requests are refused the way a browser refuses them (the card's code already
 * handles that: blocked storage, a closed passkey window, no clipboard).
 */

const refusal = (what: string) => new DOMException(`auth-kit preview: no ${what}`, 'NotAllowedError');

export const __akpFetch: typeof fetch = () => Promise.reject(new TypeError('auth-kit preview: no network'));

export const __akpStorage: Storage = Object.freeze({
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem() {
    throw refusal('storage');
  },
  removeItem() {
    throw refusal('storage');
  },
  clear() {
    throw refusal('storage');
  },
});

export const __akpCredentials: Pick<CredentialsContainer, 'get' | 'create'> = Object.freeze({
  get: () => Promise.reject(refusal('credentials')),
  create: () => Promise.reject(refusal('credentials')),
});

export const __akpClipboard: Pick<Clipboard, 'writeText'> = Object.freeze({
  writeText: () => Promise.reject(refusal('clipboard')),
});

export function __akpAssign(): void {
  throw refusal('navigation');
}
