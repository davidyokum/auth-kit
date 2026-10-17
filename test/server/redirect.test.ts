import { describe, expect, it } from 'vitest';
import { isSafeRedirect, safeRedirect } from '../../src/server/index.js';

const ch = (code: number) => String.fromCharCode(code);

describe('safeRedirect: allowed', () => {
  it.each([
    ['/', '/'],
    ['/dashboard', '/dashboard'],
    ['/reports/42?tab=notes#top', '/reports/42?tab=notes#top'],
    ['/search?q=hello%20world', '/search?q=hello%20world'],
    ['/a/./b/../c', '/a/c'],
    ['/caf%C3%A9', '/caf%C3%A9'],
    ['/path:with:colons', '/path:with:colons'],
    ['/next?redirect=https://evil.example', '/next?redirect=https://evil.example'],
  ])('%s -> %s', (input, output) => {
    expect(safeRedirect(input, '/home')).toBe(output);
    expect(isSafeRedirect(input)).toBe(true);
  });
});

describe('safeRedirect: rejected (falls back)', () => {
  const attacks: [string, string][] = [
    ['absolute URL', 'https://evil.example/'],
    ['http URL', 'http://evil.example'],
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with path', '//evil.example/login'],
    ['triple slash', '///evil.example'],
    ['backslash host', '/\\evil.example'],
    ['double backslash', '\\\\evil.example'],
    ['backslash anywhere', '/ok\\..\\evil'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['javascript scheme, upper case', 'JavaScript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript scheme', 'vbscript:msgbox(1)'],
    ['leading space before scheme', ' javascript:alert(1)'],
    ['relative path without slash', 'dashboard'],
    ['dot relative', './dashboard'],
    ['parent relative', '../dashboard'],
    ['tab inside protocol-relative', `/${ch(9)}/evil.example`],
    ['newline inside protocol-relative', `/${ch(10)}/evil.example`],
    ['carriage return', `/${ch(13)}/evil.example`],
    ['null byte', `/ok${ch(0)}`],
    ['leading space', ' /dashboard'],
    ['space in path', '/a b'],
    ['non-breaking space', `/a${ch(0xa0)}b`],
    ['line separator', `/a${ch(0x2028)}b`],
    ['ideographic space', `/${ch(0x3000)}/evil.example`],
    ['byte-order mark', `${ch(0xfeff)}/dashboard`],
    ['encoded slash', '/%2F%2Fevil.example'],
    ['encoded slash, lower case', '/%2f/evil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['encoded backslash, lower case', '/%5cevil.example'],
    ['fully encoded protocol-relative', '%2F%2Fevil.example'],
    ['double-encoded slash', '/%252F%252Fevil.example'],
    ['triple-encoded backslash', '/%25255Cevil.example'],
    ['encoded tab', '/%09/evil.example'],
    ['encoded newline (header injection)', '/ok%0d%0aSet-Cookie:%20x=1'],
    ['encoded scheme', '/%6Aavascript:alert(1)'.replace('/', '')],
    ['dot segments into protocol-relative', '/.//evil.example'],
    ['parent segments into protocol-relative', '/..//evil.example'],
    ['parent of root into protocol-relative', '/a/../..//evil.example'],
    ['empty', ''],
    ['too long', `/${'a'.repeat(3000)}`],
  ];
  it.each(attacks)('%s', (_label, input) => {
    expect(safeRedirect(input, '/home')).toBe('/home');
    expect(isSafeRedirect(input)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['/a'], new URL('https://evil.example')]) {
      expect(safeRedirect(value, '/home')).toBe('/home');
    }
  });

  it('never returns an unsafe fallback', () => {
    expect(safeRedirect('//evil.example', '//also-evil.example')).toBe('/');
    expect(safeRedirect(undefined, 'https://evil.example')).toBe('/');
  });
});

describe('safeRedirect: allowed prefixes', () => {
  it('limits results to the listed paths', () => {
    const options = { allowedPrefixes: ['/dashboard', '/admin/'] };
    expect(safeRedirect('/dashboard', '/', options)).toBe('/dashboard');
    expect(safeRedirect('/dashboard/x?y=1', '/', options)).toBe('/dashboard/x?y=1');
    expect(safeRedirect('/admin/people', '/', options)).toBe('/admin/people');
    expect(safeRedirect('/dashboardevil', '/', options)).toBe('/');
    expect(safeRedirect('/settings', '/', options)).toBe('/');
    expect(safeRedirect('/dashboard/../settings', '/', options)).toBe('/');
  });
});
