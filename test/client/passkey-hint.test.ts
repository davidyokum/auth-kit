// @vitest-environment jsdom
/**
 * The passkey hint's storage (register A5a): what it reads back. The screens' use of it is in
 * sign-in.test.ts, sign-up.test.ts, and my-account.test.ts.
 */
import { beforeEach, expect, it } from 'vitest';
import { forgetPasskey, hasPasskeyHint, rememberPasskey } from '../../src/client/passkey-hint.js';

const KEY = 'auth-kit:passkey-hint:v1';

beforeEach(() => window.localStorage.clear());

it('writes a 32-hex-character salt and hashes, never the address, and matches addresses however they’re typed', async () => {
  await rememberPasskey(' Ada@Example.org ');
  const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { salt: string; hashes: string[] };
  expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
  expect(stored.hashes).toHaveLength(1);
  // Not the address: hex never holds '@' or 'example' (a random salt can hold 'ada').
  expect(JSON.stringify(stored)).not.toContain('@');
  expect(JSON.stringify(stored).toLowerCase()).not.toContain('example');
  expect(await hasPasskeyHint('ada@example.org')).toBe(true);
  await forgetPasskey('ADA@example.org');
  expect(await hasPasskeyHint('ada@example.org')).toBe(false);
});

it('a stored salt that isn’t what it writes (too short, not hex) reads as no hint, and the next write starts over (info I2)', async () => {
  await rememberPasskey('ada@example.org');
  const stored = JSON.parse(window.localStorage.getItem(KEY)!) as { salt: string; hashes: string[] };
  for (const salt of ['x'.repeat(16), 'not hex but long enough to pass a length check', stored.salt.toUpperCase(), `${stored.salt}0`]) {
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored, salt }));
    expect(await hasPasskeyHint('ada@example.org'), salt).toBe(false);
  }
  await rememberPasskey('grace@example.org');
  const fresh = JSON.parse(window.localStorage.getItem(KEY)!) as { salt: string; hashes: string[] };
  expect(fresh.salt).toMatch(/^[0-9a-f]{32}$/);
  expect(fresh.hashes).toHaveLength(1);
  expect(await hasPasskeyHint('grace@example.org')).toBe(true);
  expect(await hasPasskeyHint('ada@example.org')).toBe(false);
});
