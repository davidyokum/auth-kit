import { expect, it } from 'vitest';
import { helpSettingProblems, parseSender, senderProblems, siteSender, senderAddressProblems } from '../../src/themes/index.js';
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
