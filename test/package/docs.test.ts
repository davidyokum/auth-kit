/**
 * The README and guides are copied into sites, so their examples must agree with the code. These
 * catch the drift that issue #10 found (a step-up link the sign-in page doesn't read).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signInUrl } from '../../src/server/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCS = ['README.md', 'docs/localhost.md', ...readdirSync(join(ROOT, 'docs', 'decisions')).map((f) => `docs/decisions/${f}`)];
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('documented examples match the code', () => {
  it('sign-in links use only the parameters the sign-in page reads (next, reauth)', () => {
    for (const file of DOCS) {
      for (const [, query] of read(file).matchAll(/\/sign-in\?([^\s"'`)]+)/g)) {
        const keys = [...new URLSearchParams(query).keys()];
        expect(keys.every((k) => k === 'next' || k === 'reauth'), `${file}: /sign-in?${query}`).toBe(true);
      }
    }
  });

  it("the admin example's step-up link comes from signInUrl, returns to the page, and says it's a step-up", () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/step-up=1/);
    expect(readme).toContain("signInUrl('/admin/people', { reauth: true })");
    expect(signInUrl('/admin/people', { reauth: true })).toBe('/sign-in?next=%2Fadmin%2Fpeople&reauth=1');
    // The sign-in page example reads both.
    expect(readme).toMatch(/const \{ next, reauth \} = await searchParams;/);
    expect(readme).toMatch(/reauth=\{reauth === '1'\}/);
  });

  it('the error-boundary example uses isAuthUnavailableError, which auth-kit/client exports', () => {
    const readme = read('README.md');
    expect(readme).toContain("import { isAuthUnavailableError } from 'auth-kit/client';");
    expect(read('src/client/index.ts')).toMatch(/isAuthUnavailableError/);
  });

  it('names the template by its URL, not as "coming later"', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/coming later/i);
    expect(readme).toContain('https://github.com/davidyokum/site-auth-kit-template');
  });
});
