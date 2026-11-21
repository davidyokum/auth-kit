#!/usr/bin/env node
// CHANGELOG.md's release line (ADR 0030). From 0.1.21 on, every section opens with one line that sites'
// upgrade PRs read to decide whether Renovate may merge them on their own:
//
//   ## [0.1.21-alpha.1] - 2026-11-25
//
//   Upgrade: patch. Site steps: none. Security: none.
//
//   Upgrade      patch | minor | major, and it must match the version jump from the section below it
//                (a new pre-release of the same version is a patch)
//   Site steps   none | see Migration. A patch has none; "see Migration" needs a "### Migration" section.
//   Security     none, or what it fixes (an advisory ID, GHSA-…, or a few words)
//
// `node scripts/check-changelog.mjs [CHANGELOG.md] [--version X]` checks every section from 0.1.21 on
// (or only X, which must exist): CI on every push, and the release job for its tag.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The first version the line is required on. */
export const FIRST_WITH_LINE = '0.1.21';

const LINE = /^Upgrade: (patch|minor|major)\. Site steps: (none|see Migration)\. Security: (.+?)\.$/;

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

function cmpNums(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The kind of jump from `from` to `to`: 'major', 'minor', 'patch', or null when `to` isn't newer. */
export function jump(from, to) {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return b.nums[i] < a.nums[i] ? null : i === 0 ? 'major' : i === 1 ? 'minor' : 'patch';
  }
  if (a.pre === b.pre || a.pre === null) return null;
  return 'patch';
}

/** The sections, newest first: { version, lines }. */
export function sections(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^## \[([^\]]+)\]/.exec(line);
    if (heading) {
      current = { version: heading[1], lines: [] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

/** Problems with the changelog's release lines ([] when none). */
export function changelogProblems(text, { only } = {}) {
  const all = sections(text);
  const problems = [];
  if (only && !all.some((s) => s.version === only)) return [`CHANGELOG.md has no section for ${only}.`];
  all.forEach((section, i) => {
    const v = parse(section.version);
    const first = parse(FIRST_WITH_LINE);
    if (!v || cmpNums(v.nums, first.nums) < 0) return;
    if (only && section.version !== only) return;
    const firstLine = section.lines.find((l) => l.trim() !== '');
    const m = LINE.exec(firstLine?.trim() ?? '');
    if (!m) {
      problems.push(`${section.version}: the section must open with "Upgrade: patch|minor|major. Site steps: none|see Migration. Security: none|<what it fixes>." (ADR 0030)`);
      return;
    }
    const [, upgrade, steps] = m;
    const previous = all[i + 1]?.version;
    const actual = previous ? jump(previous, section.version) : null;
    if (previous && actual !== upgrade) problems.push(`${section.version}: says "Upgrade: ${upgrade}" but ${previous} → ${section.version} is ${actual ? `a ${actual}` : 'not newer'} release.`);
    if (upgrade === 'patch' && steps !== 'none') problems.push(`${section.version}: a patch release has no site steps; a release that needs them is at least a minor (ADR 0030).`);
    const hasMigration = section.lines.some((l) => /^### Migration\b/.test(l));
    if (steps === 'see Migration' && !hasMigration) problems.push(`${section.version}: says "Site steps: see Migration" but has no "### Migration" section.`);
  });
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const vi = args.indexOf('--version');
  const only = vi >= 0 ? args[vi + 1]?.replace(/^v/, '') : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && (vi < 0 || i !== vi + 1)) ?? 'CHANGELOG.md';
  const problems = changelogProblems(readFileSync(file, 'utf8'), { only });
  for (const p of problems) console.error(`check-changelog: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`check-changelog: ${only ? `${only}'s release line is` : 'every release line is'} in order.`);
}
