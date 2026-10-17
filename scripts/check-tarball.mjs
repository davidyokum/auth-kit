// Checks a packed release tarball (ADR 0012): every subpath export's files are inside, nothing from
// src/ or test/ leaked in, and the package runs no lifecycle scripts on install.
// Usage: node scripts/check-tarball.mjs auth-kit-<version>.tgz
import { execFileSync } from 'node:child_process';

const tarball = process.argv[2];
if (!tarball) throw new Error('usage: node scripts/check-tarball.mjs <tarball>');

const files = new Set(
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, '')),
);
const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));

const problems = [];
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const paths = typeof target === 'string' ? [target] : Object.values(target);
  for (const path of paths) {
    if (!files.has(path.replace(/^\.\//, ''))) problems.push(`export "${subpath}" points at ${path}, which isn't in the tarball`);
  }
}
for (const file of files) {
  if (/^(src|test|scripts|\.github)\//.test(file)) problems.push(`${file} shouldn't be published`);
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
  if (pkg.scripts?.[hook]) problems.push(`package.json has a "${hook}" script; installs must run nothing`);
}

if (problems.length > 0) {
  console.error(`${tarball}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${tarball}: ${files.size} files, every export present, no install scripts.`);
