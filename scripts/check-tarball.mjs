// Checks a packed release tarball (ADR 0012): every subpath export's and bin's files are inside, nothing from
// src/ or test/ leaked in, the standalone preview isn't in it (ADR 0025), the package runs no lifecycle scripts on install, and the OpenStreetMap-derived
// data carries its ODbL notice.
// Usage: node scripts/check-tarball.mjs auth-kit-<version>.tgz
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
for (const [name, path] of Object.entries(bins)) {
  if (!files.has(path.replace(/^\.\//, ''))) problems.push(`bin "${name}" points at ${path}, which isn't in the tarball`);
}
// Files the package loads by path rather than through an export: the Lambda bundles its CDK
// constructs deploy (auth-kit/admin/cdk's InviteExpirySweep, UnverifiedAccountSweep, AccessRequestDigest),
// and the third-party notices the icons need.
for (const path of ['dist/lambda/invite-expiry/index.mjs', 'dist/lambda/unverified-sweep/index.mjs', 'dist/lambda/access-request-digest/index.mjs', 'THIRD_PARTY_NOTICES.md']) {
  if (!files.has(path)) problems.push(`${path} (deployed by auth-kit/admin/cdk) isn't in the tarball`);
}
for (const file of files) {
  if (/^(src|test|scripts|\.github)\//.test(file)) problems.push(`${file} shouldn't be published`);
  // Source maps would embed src/; dated reviews would read as current in every site's node_modules.
  if (file.endsWith('.map')) problems.push(`${file}: no source maps in the package (they embed src/)`);
  if (/^docs\/reviews\//.test(file)) problems.push(`${file}: dated reviews stay in the repo, not the package`);
  // Preview mode's standalone files are GitHub Release assets beside the tarball, never inside it (ADR 0025).
  if (/^release\//.test(file) || /(^|\/)auth-kit-preview[^/]*\.js$/.test(file)) problems.push(`${file}: the standalone preview is a release asset, not part of the package`);
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
  if (pkg.scripts?.[hook]) problems.push(`package.json has a "${hook}" script; installs must run nothing`);
}
// The OpenStreetMap-derived data is under the ODbL 1.0, not MIT (L8): the notices file says so, and so
// does every built chunk that carries the data (the County Survey and River Basins styles' code).
const unpacked = mkdtempSync(join(tmpdir(), 'auth-kit-tarball-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
  const read = (path) => readFileSync(join(unpacked, 'package', path), 'utf8');
  const notices = files.has('THIRD_PARTY_NOTICES.md') ? read('THIRD_PARTY_NOTICES.md') : '';
  for (const needed of ['Open Database License 1.0', 'src/backdrops/styles/county-survey/data.ts', 'src/backdrops/styles/river-basins/data.ts', 'not MIT']) {
    if (!notices.includes(needed)) problems.push(`THIRD_PARTY_NOTICES.md doesn't state the OpenStreetMap data's licence (missing "${needed}")`);
  }
  const osmData = { COUNTY_DATA: 0, BASIN_DATA: 0 };
  for (const file of files) {
    if (!/^dist\/.*\.js$/.test(file)) continue;
    const code = read(file);
    for (const name of Object.keys(osmData)) {
      if (!new RegExp(`\\b(?:var|const|let) ${name}\\b`).test(code)) continue;
      osmData[name]++;
      if (!/© OpenStreetMap\s+(?:\*\s+)?contributors/.test(code) || !/Open Database License 1\.0/.test(code)) {
        problems.push(`${file} carries ${name} (OpenStreetMap-derived) without its ODbL notice`);
      }
    }
  }
  for (const [name, count] of Object.entries(osmData)) {
    if (count === 0) problems.push(`no built chunk carries ${name}: the OpenStreetMap notice check found nothing to check`);
  }
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`${tarball}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${tarball}: ${files.size} files, every export present, no install scripts.`);
