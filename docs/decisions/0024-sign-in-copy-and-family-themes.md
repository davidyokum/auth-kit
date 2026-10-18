# 0024. Sign-in copy, families as themes, the card edge, the help route, and emails that match the card

- **Status:** Accepted, 2026-10-18. Decided: register A1, A4, A5, A9, E1, E2, E4, E4d, P8, and David's decisions of 2026-10-18 on emails, the help route, and the passkey icon (below). Built as configurable options while Proposed: A6 (button words), A7 (code lifetime), E5 (the card edge, "Trouble signing in?" inside the card), A10 (the authorized-use line).
- **Design:** the sign-in design report (passwords-flow `design/benchmark/REPORT.md`, kept privately) §3, §4, §5, §7; the sign-in design studio (Card Studio v4), which is newer where the two differ

## Context

`SignIn`'s words came from an early draft, its email step said "Sign in with a passkey", the password shared a screen with the email, the first-visit choice could be skipped, and the code lifetime was written into five places. Families lived in the template as loose strings. The emails were plain text from a first draft. And there was no "Trouble signing in?".

## Decision

**One copy deck.** Every screen string is in `src/client/copy.ts`, from Card Studio v4 (REPORT §4 where the studio has none). Messages for Cognito and browser errors use the same words (`describeAuthError(error, context, { siteName, codeLifetimeMinutes, helpAddress })`). Oxford commas throughout (P8); a test lints the copy for series without one.

**The flow** (A4, A5, A6):

- **Email first.** "Continue" opens "Use your passkey" ("Signing in as {email} · Change", "Waiting for your passkey…", "Try again", and no final button, because the browser's window finishes it). Before passkeys are on, "Continue" opens "Enter your password" ("for {email} · Change", Show).
- **"Use a password instead" and "Email me a code instead"** are always offered ([0018](0018-same-screens-for-every-address.md)).
- **Buttons:** **Continue** on the email and password steps (an authenticator code always follows a password, [0002](0002-mfa-optional-app-enforced-totp.md)) and the steps between; **Sign in** on the authenticator-code and emailed-code steps.
- **Errors** go in a summary that takes focus and again by the field; a closed passkey prompt gets a calm note, not red.
- **"Trouble signing in?"** opens the triage list and six help screens (`troubleLink: 'inside'`, the default, or `'below'`).
- **The card's account-creation line** for the site's mode ([0023](0023-account-creation.md); invite only: `inviteLine: 'link'`, the default, or `'sentence'`).

**The first credential is required** (A1, REPORT §3.1): `ChooseFirstCredential` has no "Not now". An account isn't left on emailed codes, the backstop, as its everyday way in.

**One code lifetime** (A7): `codeLifetimeMinutes` (default 3; Cognito allows 3 to 15) sets the pool's `AuthSessionValidity` and every sentence that says it: the screens, the custom message trigger's emails, and the simulated-code timing that keeps unknown addresses indistinguishable.

**Families as themes** (`auth-kit/themes`; E1, E2, E4, A9). One theme per family carries:

- accent colors;
- the sender's display name ("{Site} (NC OSBM)", "{Site} (UNC)", "{Site}");
- the footer identity line ("This site is managed by the NC Office of State Budget and Management", "This site is managed by UNC-Chapel Hill", none on personal sites);
- the email field's example (a site may set its own);
- the help route (below);
- an authorized-use line for OSBM, off by default while A10 is open.

`SignIn`, `SignUp`, `RequestAccess`, and the emails take the theme. **E4 on the card:** no colored line on top, nothing above the heading, identity in the footer.

**The card edge** (E5, [0021](0021-backdrops.md)): `cardEdge: 'defined'` (the default) computes a line in the family ink that reaches 3:1 against every backdrop color, as the studio's `definedEdge()` does; `'soft'` is a hairline that doesn't promise 3:1. Nothing scrims the art.

**Emails match the card** (David, 2026-10-18):

- No letterhead: the office line that opened the emails is gone, and there's no flag for it.
- The footer repeats the card's identity sentence, then the help line: "This site is managed by the NC Office of State Budget and Management. Help: {address}." Personal sites: the help line alone.
- The sender's display name stays as above. "Only enter codes at {domain}" is in every code email.
- The app's emails (invite, approved request, existing account, decline, digest, email changed, account deleted) and Cognito's code emails through the custom message trigger (`auth-kit/amplify/custom-message`: sign-in code, the first code of a sign-up, reset, new address) share one layout, with a written preheader, the code first in monospace, and no links in code emails.

**The help route** (David, 2026-10-18):

- **Scope.** The site helps only with the person's account on this site: a password reset, resetting the authenticator on their account, and moving the account to a new address after confirming it's them. For their email, device, or authenticator app itself, the screens point to the theme's IT desk ("your agency's IT help desk", "the UNC IT help desk", "your email provider, or your IT help desk if your organization runs your email"). Every contact box ends "Never send a password or code."
- **Who's named.** OSBM and UNC sites name the site's owner ("Jordan Lee looks after Example Reports"); personal and public sites say "the {Site} team" (`help.named`, with a per-site override).
- **The address.** One role-based help mailbox per family by default, with a per-site override in site config, never a person's own address. It's required, and no example ships (`theme.help.address` is empty until set): the preset's `email.replyTo` (it's the Reply-To on auth emails, and the address the screens and footers name), `createSignInHelp`, the custom message trigger, and the digest all refuse a missing or placeholder address (`helpAddressProblems`; the template's placeholder is `apps-help@replace-me.invalid`). A Super admin may override it without a deploy: Settings → "Sign-in help" (`createSignInHelpActions`, `settings.security`), stored in the app's settings table (`SiteSettingsTable`), audited, the owner alerted (refused without an alert, undone if the alert fails). The sign-in page and the app's emails read the effective address on the server, falling back to the configured one.

**The passkey icon is a fingerprint**, in the family accent (David, 2026-10-18; E4d). There's no option and no FIDO-icon path. Password rows use a password-field glyph (a rounded box with three dots), so a card never shows two keys. The fingerprint and the other line icons are Lucide's (ISC; the notice is in `src/client/icons.tsx` and `THIRD_PARTY_NOTICES.md`).

## Chosen here

- **Where the studio and REPORT differ, the studio wins**: the access lines ("Need access? Request it.", "New here? Create an account"), the sign-up code screen ("We’ve emailed {email}…", "Verify"), and the email subjects.
- **"We've emailed you a note about this"** (and "We'll email you a note when your password changes") appear only with `securityNotices: true`. auth-kit doesn't send those notices yet (REPORT §5.2f), and a screen shouldn't claim an email that isn't sent.
- **A disabled account or an expired invite reads as a wrong password** ([0018](0018-same-screens-for-every-address.md)), not REPORT's separate "You can't sign in to {Site} with this account right now", which would tell a stranger the account exists.
- **"Create a passkey on this device?"** (REPORT §3.4) stays, with "Not now", for accounts that already have another way in; it isn't the first-visit choice.
- **Forgot password** is a reset code, then "Choose a new password", then straight into the authenticator step with the new password.
- **No QR renderer ships**, so "Add an authenticator app" says "Add this setup key to your authenticator app…" unless the site passes `renderQrCode` (then the studio's "Scan the code…"). The setup link stays for same-device setup.
- **The page title's "Error: " prefix** (REPORT §3.7) is left to the page, which owns the title.
- **The defined edge is measured against all six palette colors**, counting the card's own surface for the dark ones (one line can't reach 3:1 against both the light page and the navy ink); the studio measured only the light grounds. `BACKDROP_FAMILIES[f].card.border` and `.rule` stay as brand constants, unused by the themed card (`rule` retired by E4).
- **The accent for icons is the primary button's color**, which reaches 3:1 on the card; UNC's Carolina Blue wouldn't.
- **Card width** is a CSS custom property, `--ak-card-width`, default 380px (E5's proposal), in the optional styles only.
- **Times in emails** are Eastern clock times by default (`timeZone`, `timeZoneLabel` change it). Invites reply to the inviter; every other email replies to the help address.
- **A Super admin's override doesn't reach Cognito's own Reply-To** (the pool's email configuration, set at deploy), and the custom message trigger names the configured address unless the site gives it a reader. The app's own emails and screens follow the override.

## Consequences

- A site's sign-in page renders `SignIn` alone: the card, its footer, and "Trouble signing in?" are inside it (`data-backdrop-card` on the card). The template's own card wrapper, owner line, and footer go.
- Sites pass `help` (the effective address and the owner's name) and `theme` to the screens, and the same `codeLifetimeMinutes` to the preset and the screens.
- Tests and the copy deck pin the words; changing a string is a change to `copy.ts`, reviewed against the studio.
