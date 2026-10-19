import { describe, expect, it } from 'vitest';
import { decodeSenderName, encodeSenderName, formatSenderAddress, helpSettingProblems, parseSender, senderProblems, sesSender, siteSender, senderAddressProblems } from '../../src/themes/index.js';
it('works', () => {
  expect(senderAddressProblems('sign-in@example.org')).toEqual([]);
  expect(senderAddressProblems('noreply@example.org')[0]).toMatch(/never noreply/);
  expect(senderAddressProblems('help@example.org')[0]).toMatch(/sign-in@example.org/);
  expect(siteSender('Example Reports', 'osbm', 'sign-in@example.org')).toBe('"Example Reports (NC OSBM)" <sign-in@example.org>');
  expect(siteSender('Example Reports', 'personal', 'sign-in@yokum.app')).toBe('Example Reports <sign-in@yokum.app>');
  expect(parseSender('"A (B)" <x@y.org>')).toEqual({ name: 'A (B)', address: 'x@y.org' });
  expect(senderProblems('"Example Reports (NC OSBM)" <sign-in@example.org>', { siteName: 'Example Reports', theme: 'osbm' })).toEqual([]);
  expect(senderProblems('Example Reports <sign-in@example.org>', { siteName: 'Example Reports', theme: 'osbm' }).length).toBe(1);
  expect(helpSettingProblems('jordan.lee@example.org').length).toBe(1);
  expect(helpSettingProblems({ address: 'jordan.lee@example.org', personal: true })).toEqual([]);
});

it('the personal family sends only from its own sign-in@yokum.app (register F11, info I3)', () => {
  // Without a family the address rule alone applies; with one, the family's own sender where it has one.
  expect(senderAddressProblems('sign-in@example.org')).toEqual([]);
  expect(senderAddressProblems('sign-in@example.org', 'personal')).toEqual([`"sign-in@example.org" isn't the Personal family's sender. Personal sites send from sign-in@yokum.app (register F11).`]);
  expect(senderAddressProblems('Sign-In@Yokum.App', 'personal')).toEqual([]);
  expect(senderAddressProblems('sign-in@lab.yokum.app', 'personal')[0]).toMatch(/sign-in@yokum\.app/);
  // OSBM and UNC have no shared sender: each site uses its own sign-in@ mailbox.
  expect(senderAddressProblems('sign-in@reports.example.org', 'osbm')).toEqual([]);
  expect(senderAddressProblems('sign-in@reports.example.org', 'unc')).toEqual([]);
  // Every check that knows the family applies it.
  expect(() => siteSender('Example Reports', 'personal', 'sign-in@example.org')).toThrow(/Personal sites send from sign-in@yokum\.app/);
  expect(senderProblems('Example Reports <sign-in@example.org>', { siteName: 'Example Reports', theme: 'personal' })).toHaveLength(1);
  expect(senderProblems('Example Reports <sign-in@yokum.app>', { siteName: 'Example Reports', theme: 'personal' })).toEqual([]);
});

describe('a site name outside ASCII (RFC 2047; SES takes such a name only encoded)', () => {
  const CAFE = 'Caf\u00e9 Reports';
  const CAFE_NFD = 'Cafe\u0301 Reports';
  const ENCODED_OSBM = '=?UTF-8?B?Q2Fmw6kgUmVwb3J0cyAoTkMgT1NCTSk=?=';

  it('encodes a non-ASCII name as UTF-8 B encoded-words, and leaves ASCII names alone', () => {
    expect(encodeSenderName(`${CAFE} (NC OSBM)`)).toBe(ENCODED_OSBM);
    expect(encodeSenderName(`${CAFE_NFD} (NC OSBM)`)).toBe(ENCODED_OSBM);
    expect(encodeSenderName('Example Reports (NC OSBM)')).toBe('Example Reports (NC OSBM)');
  });

  it('splits a long name into encoded-words of at most 75 characters, never splitting a character, and decodes it back', () => {
    const long = '\u00d1and\u00fa Budget Office of the Very Long Name Department \u2014 \u65e5\u672c\u8a9e (UNC)';
    const encoded = encodeSenderName(long);
    const words = encoded.split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      // Each word is whole UTF-8 on its own (no character split across words).
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).not.toThrow();
    }
    expect(decodeSenderName(encoded)).toBe(long);
  });

  it('decodes B and Q words, any case, drops the space between two words, and keeps an undecodable word as written', () => {
    expect(decodeSenderName(ENCODED_OSBM)).toBe(`${CAFE} (NC OSBM)`);
    expect(decodeSenderName('=?utf-8?q?Caf=C3=A9_Reports?=')).toBe(CAFE);
    expect(decodeSenderName('=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?B?IFJlcG9ydHM=?=')).toBe(CAFE);
    expect(decodeSenderName('=?ISO-8859-1?Q?Caf=E9?= Reports')).toBe(CAFE);
    expect(decodeSenderName('=?UTF-8?B?!!!?=')).toBe('=?UTF-8?B?!!!?=');
    expect(decodeSenderName(CAFE_NFD)).toBe(CAFE);
  });

  it('the sender checks compare names decoded and normalized, so a plain, an encoded, or a decomposed name all match the site', () => {
    const site = { siteName: CAFE, theme: 'osbm' as const };
    expect(senderProblems(`"${CAFE} (NC OSBM)" <sign-in@reports.example.org>`, site)).toEqual([]);
    expect(senderProblems(`${ENCODED_OSBM} <sign-in@reports.example.org>`, site)).toEqual([]);
    expect(senderProblems(`"${CAFE_NFD} (NC OSBM)" <sign-in@reports.example.org>`, site)).toEqual([]);
    expect(senderProblems(`${ENCODED_OSBM} <sign-in@reports.example.org>`, { siteName: CAFE_NFD, theme: 'osbm' })).toEqual([]);
    // A different name is still refused, and the message shows it decoded.
    expect(senderProblems('=?UTF-8?B?Q2Fmw6k=?= <sign-in@reports.example.org>', site)).toEqual([`The sender's name is "${CAFE} (NC OSBM)" (register E4a), not "Caf\u00e9".`]);
  });

  it('siteSender, formatSenderAddress, and sesSender write the SES form: encoded, never quoted, never encoded twice', () => {
    expect(siteSender(CAFE, 'osbm', 'sign-in@reports.example.org')).toBe(`${ENCODED_OSBM} <sign-in@reports.example.org>`);
    expect(formatSenderAddress(`${CAFE} (NC OSBM)`, 'sign-in@reports.example.org')).toBe(`${ENCODED_OSBM} <sign-in@reports.example.org>`);
    expect(formatSenderAddress(ENCODED_OSBM, 'sign-in@reports.example.org')).toBe(`${ENCODED_OSBM} <sign-in@reports.example.org>`);
    expect(sesSender(`"${CAFE} (NC OSBM)" <sign-in@reports.example.org>`)).toBe(`${ENCODED_OSBM} <sign-in@reports.example.org>`);
    expect(sesSender(`${ENCODED_OSBM} <sign-in@reports.example.org>`)).toBe(`${ENCODED_OSBM} <sign-in@reports.example.org>`);
    // ASCII names are as before.
    expect(sesSender('"Example Reports (NC OSBM)" <sign-in@example.org>')).toBe('"Example Reports (NC OSBM)" <sign-in@example.org>');
    expect(sesSender('sign-in@example.org')).toBe('sign-in@example.org');
    expect(senderProblems(siteSender(CAFE, 'osbm', 'sign-in@reports.example.org'), { siteName: CAFE, theme: 'osbm' })).toEqual([]);
  });
});
