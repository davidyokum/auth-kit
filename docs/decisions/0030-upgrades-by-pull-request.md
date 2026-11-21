# 0030. Sites get every release as a pull request; patches with no site steps merge on their own

- **Status:** Accepted, 2026-11-21
- **Amends:** [0012](0012-release-tarballs.md) (what a release's notes must say) and [0028](0028-the-owner-decides-and-the-kit-deploys.md) (how a site learns of a release).

## Context

Each site pins one exact release: the tarball URL in `package.json`, its sha512 in `package-lock.json`. That's deliberate (ADR 0012), and it means a site moves only when someone moves it. Until now that someone was a person (or Claude) opening an upgrade PR on every site after every release, by hand. It worked for seven sites because it was remembered every time; a site added later, or a release on a busy day, could be missed, and a security fix would reach each site only as fast as the slowest hand.

The standard answer is "notify by pull request, never by surprise": a bot opens the upgrade PR, checks gate it, and the PR is how a site knows. Two things make the stock tools a poor fit as they come:

- **Dependabot and Renovate's npm manager skip URL dependencies.** Neither sees a new auth-kit release.
- **Their lockfile step is `npm install`.** It re-resolves the whole tree. Twice that wrote a lockfile Amplify's npm refused, which is why `auth-kit upgrade` exists: it changes only the kit's lines and checks them with Amplify's npm (ADR 0028).

## Decision

1. **Renovate, scoped to auth-kit.** Every site's `renovate.json` extends the template's preset, `github>davidyokum/site-auth-kit-template//renovate/auth-kit`. It enables only a custom regex manager that reads the tarball URL in `package.json` and looks releases up on this repo's GitHub Releases (pre-releases count). It changes nothing else; Dependabot keeps every other dependency. Patch and minor releases get separate PRs, with the release's notes in the description.
2. **The site finishes the PR, not Renovate.** The template's "auth-kit upgrade" workflow (`.github/workflows/kit-upgrade.yml`) runs on Renovate's branch. It checks the tarball's SHA256SUMS and provenance attestation, runs that release's own `auth-kit upgrade` on the base branch's two files, and commits the result as `github-actions[bot]` (an author Renovate ignores, so it keeps rebasing). It then starts CI and itself on that commit. There it checks that only the kit's lines changed and that the lockfile pins the attested tarball.
3. **Every release says what it asks of a site, on one line.** From 0.1.21, each `CHANGELOG.md` section, and so each release's notes, opens with:

   ```
   Upgrade: patch. Site steps: none. Security: none.
   ```

   - **Upgrade** is the semver kind, and it must match the version jump. `scripts/check-changelog.mjs` refuses a mismatch in CI and in the release job. From now on, versions carry meaning: a **patch** fixes things and needs nothing from a site. A **minor** adds features or asks a site to do something, such as copying a file, new CSS, a prop, or a setting. A **major** (1.0 on) can break things. 0.1.13 through 0.1.20 were all "patch" releases with Migration steps; under this rule most of them would have been minors.
   - **Site steps** is `none` or `see Migration`. A patch never has site steps, and `see Migration` needs a `### Migration` section.
   - **Security** is `none`, or what the release fixes (`GHSA-…` when there's an advisory). Publish the advisory on this repo as well. Renovate can't read GitHub's advisory database for a URL dependency, so this line is what flags the PRs.
4. **The merge rule.** The workflow sets the `auth-kit/auto-merge` status on the finished commit. It's green only when the release is a patch whose line says `Site steps: none`. Renovate then squash-merges once every status and check is green, and the merge deploys as any merge to `main` does. Anything else stays **pending** with its reason, and Renovate never merges it: a minor or major release, a patch whose notes list steps, notes without the line, or a red check. Those wait for the owner, who reads the notes, does the steps on the PR's branch, and merges. A security fix adds the `auth-kit security fix` label and a comment to merge it soon.
5. **One place shows who's behind.** The owner's private site security board lists each site's version and flags any site more than one release behind the newest.

## Consequences

- No site can miss a release, and a new site made from the template gets this with no setup beyond adding its repository to the Renovate GitHub app.
- A site's auto-merge is only as good as its checks. Template sites run the whole of `npm run check` in CI. A site without CI sets `SITE_CHECKS` in its copy of the workflow to its typecheck, tests, and build. A site whose CI is red on `main` never auto-merges, which is the safe way to fail.
- Releasing is now a promise to every site: the release line has to be honest. A patch must really need nothing, because nobody looks before it goes live. When in doubt, call it a minor.
- The Renovate app holds write access to the repositories it's installed on. Install it on the site repositories and the template only (not "All repositories").
- Patch PRs merge within a few hours of a release, when Renovate next runs on the repository. Nothing here can push a release to sites faster than that. For an urgent fix, merge the PRs by hand.
