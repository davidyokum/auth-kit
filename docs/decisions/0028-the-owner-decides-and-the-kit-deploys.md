# 0028. The owner decides, the kit deploys: a first visit that's one code, and owner, deploy, and upgrade commands

- **Status:** Accepted, 2026-11-14
- **Amends:** [0001](0001-passkey-first.md)'s order (the final domain now comes before the first sign-in, not after it), and the template's setup and deploy steps.

## Context

A retrospective of five real sites (November 2026: the Lectern talk site, the APA talk, the Oak Spire proposal site, the Oak Spire member website, and PMA Event Series) found the kit's screens mostly worked, and the hand-off to the agents that build sites did not:

- **Nothing outside the kit pointed to it.** One site got a hand-built Cognito page with no password reset.
- **Setup's questions never reached the owner.** Agents ran `npm run setup -- … --yes` with their own answers and `npm run backdrop:lock`, so four of four sites shipped a backdrop the owner never chose.
- **The first sign-in met an unfinished site.** Sites deployed on `amplifyapp.com` with passkeys off; the owner was made by two hand-typed AWS commands with no email, then sent to `/sign-in` with instructions. A first visit with passkeys off went to "Enter your password", which a new account doesn't have; with passkeys on it took email, Continue, a chooser, then the code. Then the domain arrived, the account was reset, and it happened again.
- **The last mile stalled.** Deploying was nine manual steps; finished work sat undeployed for days.
- **A leak no check caught.** A client component imported protected agendas, so attendee names shipped in a public `/_next/static` file.
- **Upgrades broke builds.** `npm install <url>` re-resolved the tree, and the lockfile it wrote failed Amplify's `npm ci` twice.

## Decision

- **A first visit (`?first=1`) is one code and one fingerprint.** The email step's button is "Email me a code" and sends it, for every address alike (nothing about the account is revealed). The invite link carries the address in its fragment (`#email=`, never sent to a server); the card fills it in and removes it. Passkeys and passwords stay as the other ways. The line under the field says what follows on this site: a passkey, or, before passkeys are on, a password.
- **`npx auth-kit owner`** makes the one owner (no password, Cognito's email suppressed, the owner group) and sends them the same invite as anyone else, role Owner. It refuses another account's pool, a site with a different owner, and an address that has signed in; run again, it re-sends the invite.
- **`npx auth-kit deploy`** does the last mile in order: account check, GitHub repository, service role, Amplify app, branch with `APP_ORIGIN`, first build, compute role and a rebuild, the final address (printing its DNS records), then the owner. Without `--yes` it only reads and prints the plan, which is what the owner approves once. Every step skips what exists. The final address comes before the owner, so passkeys work from the first sign-in and no account is reset later. The GitHub token reaches Amplify in a 0600 file, never on a command line.
- **`npx auth-kit upgrade <version>`** changes only the kit's lines in `package.json` and `package-lock.json`, refuses when the new release needs a dependency the lockfile can't give, and checks with Amplify's npm (`npx npm@10.9.9 ci --dry-run`), restoring both files if it fails.
- **`check-prod-build --protected <file>`** fails when a protected phrase (from a site's roster, agendas, or any file it names) appears in `.next/static`, escaped forms included, naming the file and the source but never the phrase.
- **The setup screens say two things they didn't:** once an authenticator is added, sign-in codes come from it, not email; and a password manager's empty passkey window is closed, then Try again.

The template carries the rest: setup records which answers the owner gave and refuses `--yes` for the ones they didn't, asks for the final address and the backdrop, drops `backdrop:lock`, and a deploy fails unless the owner chose the backdrop.

## Consequences

- The owner's first sign-in is: open the invite, press Email me a code, type the code, touch the fingerprint.
- An agent can't finish a site's setup without putting its questions to the owner; it can still deploy without stopping at each console step.
- Sites made before this keep working. The invite's new link and steps reach every site on its next upgrade; `owner`, `deploy`, and `upgrade` are new commands and change nothing until run.
