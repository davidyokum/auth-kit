/**
 * Reading a pasted list of addresses for "Add several at once" (ADR 0029). Pure and linear: the server
 * (`inviteMany`) and the form's live count both use it, so the count on the button is the count sent.
 *
 * Entries are separated by commas, semicolons, or new lines; inside an entry, white space separates
 * bare addresses. `Name <address>` gives the address, and a quoted name may hold a comma
 * (`"Lovelace, Ada" <ada@example.org>`). An entry whose name is itself a different address
 * (`boss@agency.gov <someone@elsewhere.example>`) is refused rather than guessed.
 */

/** The longest paste read at all: 50 addresses of 320 characters plus names fits well inside it. */
export const INVITE_MANY_MAX_CHARS = 32_000;

export interface InviteListParse {
  /** Each address-like piece, in order, as written (not yet checked or lowercased). */
  addresses: string[];
  /** Pieces that can't be read as one address, shortened for display. */
  unreadable: string[];
  /** True when the paste is longer than `INVITE_MANY_MAX_CHARS` (nothing else is read). */
  tooLong: boolean;
}

const SEPARATORS = new Set([',', ';', '\n', '\r']);

/** Splits on separators outside quotes and angle brackets, in one pass. */
function entriesOf(text: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of text) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<' && !inQuote) inAngle = true;
    else if (ch === '>' && !inQuote) inAngle = false;
    if (SEPARATORS.has(ch) && !inQuote && !inAngle) {
      entries.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  entries.push(current);
  return entries.map((e) => e.trim()).filter((e) => e !== '');
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** The addresses in pasted text. Linear in the length of the text; refuses a paste over the cap. */
export function parseInviteList(text: string): InviteListParse {
  if (text.length > INVITE_MANY_MAX_CHARS) return { addresses: [], unreadable: [], tooLong: true };
  const addresses: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entriesOf(text)) {
    const open = entry.indexOf('<');
    if (open === -1) {
      for (const piece of entry.split(/\s+/)) if (piece !== '') addresses.push(piece);
      continue;
    }
    const close = entry.indexOf('>', open);
    const inside = close === -1 ? '' : entry.slice(open + 1, close).trim();
    const after = close === -1 ? '' : entry.slice(close + 1).trim();
    const name = entry.slice(0, open).trim().replace(/^"(.*)"$/, '$1').trim();
    // One address per bracketed entry, nothing after it, and a name that isn't some other address.
    if (inside === '' || after !== '' || entry.indexOf('<', open + 1) !== -1 || (name.includes('@') && name.toLowerCase() !== inside.toLowerCase())) {
      unreadable.push(short(entry));
      continue;
    }
    addresses.push(inside);
  }
  return { addresses, unreadable, tooLong: false };
}
