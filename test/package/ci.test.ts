/**
 * The screenshot job's container must be the Playwright the package installs, or the baseline images
 * (taken in that container) stop matching; and the release must carry preview mode's files beside the
 * tarball under the same attestation (ADR 0012, ADR 0025).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('CI', () => {
  const workflow = read('.github/workflows/ci.yml');
  const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };

  it('runs the screenshot tests in the Playwright image the package pins, exactly', () => {
    const version = pkg.devDependencies['@playwright/test'];
    expect(version, 'an exact version, never a range').toMatch(/^\d+\.\d+\.\d+$/);
    const images = [...workflow.matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/g)].map((m) => m[1]);
    expect(images).toEqual([version]);
    // The local command in playwright.config.ts uses the same image.
    expect([...read('playwright.config.ts').matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/g)].map((m) => m[1])).toEqual([version]);
  });

  it('pins every action to a commit', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(4);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });

  it('releases only after the screenshot tests pass, with the standalone preview attested and attached', () => {
    expect(workflow).toMatch(/release:\n(?:.*\n)*?\s+needs: \[check, screenshots\]/);
    const release = workflow.slice(workflow.indexOf('  release:'));
    expect(release).toContain('npm run build:preview');
    for (const file of ['auth-kit-preview.js', 'auth-kit-preview-backdrops.js']) {
      expect(release.match(/subject-path: \|\n((?:\s{12}.*\n)+)/)?.[1], `${file} attested`).toContain(file);
      expect(release.match(/gh release create .*/)?.[0], `${file} attached`).toContain(file);
      expect(release.match(/sha256sum .*/)?.[0], `${file} in SHA256SUMS`).toContain(file);
    }
  });
});
