/**
 * CHANGELOG.md's release line (ADR 0030): from 0.1.21 on, every section opens with
 * "Upgrade: … Site steps: … Security: …", which sites' Renovate PRs read to decide whether they may
 * merge on their own. scripts/check-changelog.mjs enforces it in CI and in the release job.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-changelog.mjs');

function check(text: string, ...args: string[]): { ok: boolean; output: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'changelog-')), 'CHANGELOG.md');
  writeFileSync(file, text);
  try {
    return { ok: true, output: execFileSync('node', [SCRIPT, file, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { ok: false, output: String((err as { stderr?: string }).stderr ?? err) };
  }
}

const head = (v: string, line: string, body = 'Words.') => `## [${v}] - 2026-11-25\n\n${line}\n\n${body}\n\n`;
const base = '## [0.1.20-alpha.1] - 2026-11-19\n\nSimple sign-in.\n';

describe('CHANGELOG.md release lines', () => {
  it('passes on the real changelog', () => {
    expect(check(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).ok).toBe(true);
  });

  it('accepts a patch with no site steps, and a minor with a Migration section', () => {
    expect(check(head('0.1.21-alpha.1', 'Upgrade: patch. Site steps: none. Security: none.') + base).ok).toBe(true);
    expect(check(head('0.2.0-alpha.1', 'Upgrade: minor. Site steps: see Migration. Security: GHSA-abcd-1234-wxyz.', '### Migration\n\nCopy a file.') + base).ok).toBe(true);
    expect(check(head('0.1.21-alpha.2', 'Upgrade: patch. Site steps: none. Security: none.') + head('0.1.21-alpha.1', 'Upgrade: patch. Site steps: none. Security: none.') + base).ok).toBe(true);
  });

  it('refuses a section without the line, a kind that doesn’t match the version, and a patch with site steps', () => {
    expect(check(head('0.1.21-alpha.1', 'Fixes a thing.') + base).output).toContain('must open with');
    expect(check(head('0.1.21-alpha.1', 'Upgrade: minor. Site steps: none. Security: none.') + base).output).toContain('is a patch release');
    expect(check(head('0.2.0-alpha.1', 'Upgrade: patch. Site steps: none. Security: none.') + base).output).toContain('is a minor release');
    expect(check(head('0.1.21-alpha.1', 'Upgrade: patch. Site steps: see Migration. Security: none.', '### Migration\n\nx') + base).output).toContain('has no site steps');
    expect(check(head('0.2.0-alpha.1', 'Upgrade: minor. Site steps: see Migration. Security: none.') + base).output).toContain('no "### Migration" section');
  });

  it('checks one version for the release job, and refuses one with no section', () => {
    const text = head('0.1.21-alpha.1', 'Upgrade: patch. Site steps: none. Security: none.') + base;
    expect(check(text, '--version', 'v0.1.21-alpha.1').ok).toBe(true);
    expect(check(text, '--version', '0.1.22-alpha.1').output).toContain('no section for 0.1.22-alpha.1');
  });

  it('runs in CI and in the release job', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('node scripts/check-changelog.mjs\n');
    expect(workflow).toContain('node scripts/check-changelog.mjs --version "$GITHUB_REF_NAME"');
  });
});
