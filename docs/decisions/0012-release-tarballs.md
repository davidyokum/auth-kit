# 0012. Releases are attested tarballs built once in CI

- **Status:** Accepted, 2026-10-17 (supersedes installing from a git tag with an install-time build)
- **Review:** M4 in [the 2026-10-17 review](../reviews/2026-10-17-fable-review.md)

## Context

`v0.1.0-alpha` was installed with `npm i github:davidyokum/auth-kit#v0.1.0-alpha`. npm clones the repo, installs its devDependencies (`aws-cdk-lib`, `next`, `vitest`, `tsup`, esbuild, about a thousand packages) on every site's machine and CI, runs their install scripts there, and builds `dist/` from whatever resolves that day. Two sites could ship different code from one tag, and a git tag can be moved. For the package that does auth on every site, that was the widest supply-chain surface in the repo.

Options considered:

1. **Public npm with `--provenance`.** The best long-term home, but it needs an npm account and token set up by hand.
2. **Commit `dist/` to a release branch or tag commits.** No devDependencies on install, but npm still fetches a git commit, the lockfile records only the commit hash (no content hash), and built output lands in git history.
3. **A packed tarball attached to a GitHub Release, built once in CI.** No account to set up, and the lockfile pins the tarball's content.

## Decision

Option 3.

- Pushing a `v*` tag runs the `release` job in `.github/workflows/ci.yml` after the normal checks: it checks the tag matches `package.json`, runs `npm ci --ignore-scripts` from the lockfile, builds, `npm pack`s, checks the tarball holds every export and no install scripts (`scripts/check-tarball.mjs`), records a GitHub build-provenance attestation for it, and attaches it (plus `SHA256SUMS`) to a GitHub Release. It never overwrites an existing release.
- Sites install the tarball by URL. npm writes its `sha512` into `package-lock.json`, so `npm ci` refuses a tarball that changed, and nothing of auth-kit's builds or runs on install.
- `package.json` has no `prepare` script, so a stray `github:` install no longer pulls the dev toolchain; it installs without `dist/` and fails loudly at the first import.
- Dependabot opens weekly update PRs for npm packages and the SHA-pinned actions.

## Consequences

- Install and upgrade: `npm i https://github.com/davidyokum/auth-kit/releases/download/vX.Y.Z/auth-kit-X.Y.Z.tgz`, then commit the lockfile. Anyone can check a tarball came from this repo's CI with `gh attestation verify auth-kit-X.Y.Z.tgz --repo davidyokum/auth-kit`.
- Release assets can be deleted, which breaks fresh installs of that version (never silently changes them). Turning on GitHub's immutable releases for the repo (Settings, a manual step) would close that too.
- Dependabot can't update a URL dependency; sites bump the URL by hand (the template can automate it later).
- Moving to npm later reuses the same job: add `npm publish --provenance` after the pack step.
