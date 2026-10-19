import { expect, it } from 'vitest';
import { helpSettingProblems, parseSender, senderProblems, siteSender, senderAddressProblems } from '../../src/themes/index.js';
it('works', () => {
  expect(senderAddressProblems('sign-in@example.org')).toEqual([]);
  expect(senderAddressProblems('noreply@example.org')[0]).toMatch(/never noreply/);
  expect(senderAddressProblems('help@example.org')[0]).toMatch(/sign-in@example.org/);
  expect(siteSender('Example Reports', 'osbm', 'sign-in@example.org')).toBe('"Example Reports (NC OSBM)" <sign-in@example.org>');
  expect(siteSender('Example Reports', 'personal', 'sign-in@example.org')).toBe('Example Reports <sign-in@example.org>');
  expect(parseSender('"A (B)" <x@y.org>')).toEqual({ name: 'A (B)', address: 'x@y.org' });
  expect(senderProblems('"Example Reports (NC OSBM)" <sign-in@example.org>', { siteName: 'Example Reports', theme: 'osbm' })).toEqual([]);
  expect(senderProblems('Example Reports <sign-in@example.org>', { siteName: 'Example Reports', theme: 'osbm' }).length).toBe(1);
  expect(helpSettingProblems('jordan.lee@example.org').length).toBe(1);
  expect(helpSettingProblems({ address: 'jordan.lee@example.org', personal: true })).toEqual([]);
});
