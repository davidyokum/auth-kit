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
    // The sign-in page example reads all three: next, step-up, and a first visit (an invite's link).
    expect(readme).toMatch(/const \{ next, reauth, first \} = await searchParams;/);
    expect(readme).toMatch(/reauth=\{reauth === '1'\}/);
    expect(readme).toMatch(/firstVisit=\{first === '1'\}/);
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

describe('the OpenStreetMap data’s licence is stated (v0.1.9 review, L8)', () => {
  const DATA = ['src/backdrops/styles/county-survey/data.ts', 'src/backdrops/styles/river-basins/data.ts'];

  it('each OSM-derived data file opens with a legal comment the build keeps (/*! … */), naming the ODbL and the MIT carve-out', () => {
    for (const file of DATA) {
      const head = read(file).slice(0, 600);
      expect(head.startsWith('/*!'), file).toBe(true);
      expect(head, file).toMatch(/© OpenStreetMap\s+(?:\*\s+)?contributors/);
      expect(head, file).toContain('Open Database License 1.0');
      expect(head, file).toContain('not under auth-kit');
      expect(head, file).toContain('THIRD_PARTY_NOTICES.md');
    }
  });

  it('THIRD_PARTY_NOTICES.md says the data is under the ODbL 1.0, not MIT, file by file; LICENSE stays MIT; the README points there', () => {
    const notices = read('THIRD_PARTY_NOTICES.md');
    expect(notices).toContain('## Licences in this package');
    expect(notices).toMatch(/OpenStreetMap map data, under the ODbL 1\.0, not MIT/);
    for (const file of DATA) expect(notices).toContain(file);
    expect(notices).toContain('https://opendatacommons.org/licenses/odbl/1-0/');
    expect(read('LICENSE').startsWith('MIT License')).toBe(true);
    expect(read('LICENSE')).not.toMatch(/ODbL|OpenStreetMap/);
    expect(read('README.md')).toMatch(/## License\n\n\[MIT\]\(LICENSE\)\. The OpenStreetMap-derived map data .* Open Database License 1\.0, not MIT/);
    // The sheets keep their own attribution (a produced work's notice), in the frozen v1 files.
    expect(read('src/backdrops/styles/county-survey/v1.ts')).toContain('WATER FEATURES © OPENSTREETMAP CONTRIBUTORS');
    expect(read('src/backdrops/styles/river-basins/v1.ts')).toContain('WATER FEATURES © OPENSTREETMAP CONTRIBUTORS');
  });
});
