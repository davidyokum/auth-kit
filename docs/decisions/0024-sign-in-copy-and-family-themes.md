# 0024. Sign-in copy, families as themes, the card edge, the help route, and emails that match the card

- **Status:** Accepted, 2026-10-18. Decided: register A1, A4, A5, A9, E1, E2, E4, E4d, P8, and David's decisions of 2026-10-18 on emails, the help route, and the passkey icon (below). Amended 2026-10-19 ([below](#amendment-2026-10-19-the-registers-decisions)): A6 (the button words), A7 (10 minutes), A10 (sender, notices, no authorized-use line), C1, E4c, E5 (the card), and F11 (the personal family on yokum.app) are decided, and built as decided, not as options.
- **Design:** the sign-in design report (passwords-flow `design/benchmark/REPORT.md`, kept privately) §3, §4, §5, §7; the sign-in design studio (Card Studio v4), which is newer where the two differ

## Context

`SignIn`'s words came from an early draft, its email step said "Sign in with a passkey", the password shared a screen with the email, the first-visit choice could be skipped, and the code lifetime was written into five places. Families lived in the template as loose strings. The emails were plain text from a first draft. And there was no "Trouble signing in?".

## Decision

**One copy deck.** Every screen string is in `src/client/copy.ts`, from Card Studio v4 (REPORT §4 where the studio has none). Messages for Cognito and browser errors use the same words (`describeAuthError(error, context, { siteName, codeLifetimeMinutes, helpAddress })`). Oxford commas throughout (P8); a test lints the copy for series without one.

**The flow** (A4, A5, A6):

- **Email first.** "Continue" opens "Use your passkey" ("Signing in as {email} · Change", "Waiting for your passkey…", "Try again", and no final button, because the browser's window finishes it) only when this browser remembers a passkey for the address; otherwise "How do you want to sign in?" (amended 2026-10-19, register A5a, [below](#amendment-2026-10-19-continue-opens-the-passkey-prompt-only-where-this-browser-remembers-one)). Before passkeys are on, "Continue" opens "Enter your password" ("for {email} · Change", Show).
- **"Use a password instead" and "Email me a code instead"** are always offered ([0018](0018-same-screens-for-every-address.md)).
- **Buttons** (register A6, decided 2026-10-19; fixed words in `copy.ts`, not options): **Continue** on the email and password steps (an authenticator code always follows a password, [0002](0002-mfa-optional-app-enforced-totp.md)) and the steps between, the sign-up code step included; **Sign in** on the authenticator-code and emailed-code steps.
- **Errors** go in a summary that takes focus and again by the field; a closed passkey prompt gets a calm note, not red.
- **"Trouble signing in?"** opens the triage list and six help screens (`troubleLink: 'inside'`, the default, or `'below'`).
- **The card's account-creation line** for the site's mode ([0023](0023-account-creation.md); invite only: `inviteLine: 'link'`, the default, or `'sentence'`).

**The first credential is required** (A1, REPORT §3.1): `ChooseFirstCredential` has no "Not now". An account isn't left on emailed codes, the backstop, as its everyday way in. **The server enforces it** (amended 2026-10-18, after the security review): `requireUser` refuses an account with neither a passkey nor a password (403 `first_credential_required`, `getUser` returns `null`), and page guards send it to the chooser (`firstCredentialPath`, default `/account/sign-in-method`, the one page that passes `allowFirstCredentialEnrollment`). So closing the tab at the chooser, blocking the factors read, or reloading can't leave an account on codes. `SignIn` never goes in after a failed factors read: it says it couldn't check, with Try again.

**One code lifetime** (A7, decided 2026-10-19: 10 minutes): `codeLifetimeMinutes` (default 10; Cognito allows 3 to 15) sets the pool's `AuthSessionValidity` and every sentence that says it: the screens, the custom message trigger's emails, and the simulated-code timing that keeps unknown addresses indistinguishable.

**Families as themes** (`auth-kit/themes`; E1, E2, E4, A9). One theme per family carries:

- accent colors;
- the sender's display name ("{Site} (NC OSBM)", "{Site} (UNC)", "{Site}");
- the footer identity line ("This site is managed by the NC Office of State Budget and Management", "This site is managed by UNC-Chapel Hill", none on personal sites);
- the email field's example (a site may set its own);
- the help route (below);
- the card's style (E5, below).

There's no authorized-use line: register A10 dropped it (2026-10-19), and `showAuthorizedUse` throws. No MyNCID-like colours, and nothing reserves a "Sign in with NCID" slot (backlog, only if state single sign-on happens).

`SignIn`, `SignUp`, `RequestAccess`, and the emails take the theme. **E4 on the card:** no colored line on top, nothing above the heading, identity in the footer.

**The card edge** (E5, [0021](0021-backdrops.md)): `cardEdge: 'defined'` (the default, decided) computes a line in the family ink that reaches 3:1 against every backdrop color, as the studio's `definedEdge()` does; `'soft'` is a hairline that doesn't promise 3:1. Nothing scrims the art, except the Plain style's soft column (below).

**Emails match the card** (David, 2026-10-18):

- No letterhead: the office line that opened the emails is gone, and there's no flag for it.
- The footer repeats the card's identity sentence, then the help line: "This site is managed by the NC Office of State Budget and Management. Help: {address}." Personal sites: the help line alone.
- The sender's display name stays as above. "Only enter codes at {domain}" is in every code email.
- The app's emails (invite, approved request, existing account, decline, digest, email changed, account deleted) and Cognito's code emails through the custom message trigger (`auth-kit/amplify/custom-message`: sign-in code, the first code of a sign-up, reset, new address) share one layout, with a written preheader, the code first in monospace, and no links in code emails.

**The help route** (David, 2026-10-18):

- **Scope.** The site helps only with the person's account on this site: a password reset, resetting the authenticator on their account, and moving the account to a new address after confirming it's them. For their email or authenticator app itself, the screens point to the theme's IT desk ("your agency's IT help desk", "the UNC IT help desk", "your email provider, or your IT help desk if your organization runs your email"); for a device or browser that isn't working, to its device desk (`devDesk`: the same for OSBM and UNC; "the device maker's support" on personal sites, as Card Studio has it). Every contact box ends "Never send a password or code."
- **Who's named.** OSBM and UNC sites name the site's owner ("Jordan Lee looks after Example Reports"); personal and public (open sign-up) sites say "the {Site} team" (`help.named`, with a per-site override; open sign-up sites automatically, and without the Teams line, since 2026-10-19).
- **The address.** One role-based help mailbox per family by default, with a per-site override in site config; a person's own address only with the site's acknowledgement (amended 2026-10-19, E4c). It's required, and OSBM and UNC ship no example (`theme.help.address` is empty until set; personal: `help@yokum.app`, F11): the preset's `email.replyTo` (it's the Reply-To on auth emails, and the address the screens and footers name), `createSignInHelp`, the custom message trigger, and the digest all refuse a missing or placeholder address (`helpAddressProblems`; the template's placeholder is `apps-help@replace-me.invalid`). A Super admin may override it without a deploy: Settings → "Sign-in help" (`createSignInHelpActions`, `settings.security`), stored in the app's settings table (`SiteSettingsTable`), audited, the owner and every Super admin alerted (refused without an alert, undone if the alert fails). The override stays on the configured address's domain or the family's own (`theme.help.domains`: nc.gov, unc.edu, yokum.app; `allowedDomains` for a help desk elsewhere), and is a plain mailbox (no `?subject=`, `#`, or `%` in the local part), so a hijacked Super admin session can't point every help screen and Reply-To at an outside mailbox; a stored value off the list falls back to the configured address. The sign-in page and the app's emails read the effective address on the server, falling back to the configured one.

**The passkey icon is a fingerprint**, in the family accent (David, 2026-10-18; E4d). There's no option and no FIDO-icon path. Password rows use a password-field glyph (a rounded box with three dots), so a card never shows two keys. The fingerprint and the other line icons are Lucide's (ISC; the notice is in `src/client/icons.tsx` and `THIRD_PARTY_NOTICES.md`).

## Chosen here

- **Where the studio and REPORT differ, the studio wins**: the access lines (one per mode, register D1: "New to {Site}? Request access", "… Create an account with your {domains} email address.", "… Create an account"), the sign-up code screen ("We’ve emailed {email}…", "Continue", register A6), and the email subjects.
- **"We've emailed you a note about this"** appears only after the site's notice route said it sent the notice (amended 2026-10-19: the notices are on by default, below); "We'll email you a note when your password changes" appears wherever notices are on (`notices: false` turns both off). A screen never claims an email that wasn't sent.
- **A disabled account or an expired invite reads as a wrong password** ([0018](0018-same-screens-for-every-address.md)), not REPORT's separate "You can't sign in to {Site} with this account right now", which would tell a stranger the account exists; on the passkey and emailed-code paths it gets the decoy prompt and the simulated code, and an account whose password must be reset is treated the same way.
- **The decoy passkey prompt carries the pool's relying-party ID and timeout** when the site passes `SignIn`'s `passkey` prop, so the browser's sheet looks the same for an unknown address.
- **Copy changes from the review of the studio's words** (2026-10-18): "We couldn't create your passkey. Try again, or use a password instead." (the old "continue without one" promised a skip the chooser doesn't have); "Try again, or use another way below." for a rejected passkey, matching the cancelled one; request access says "We couldn't send your request. Check your connection and try again." instead of the sign-in service's message.
- **"Create a passkey on this device?"** (REPORT §3.4) stays, with "Not now", for accounts that already have another way in; it isn't the first-visit choice.
- **Forgot password** is a reset code, then "Choose a new password", then straight into the authenticator step with the new password.
- **No QR renderer ships**, so "Add an authenticator app" says "Add this setup key to your authenticator app…" unless the site passes `renderQrCode` (then the studio's "Scan the code…"). The setup link stays for same-device setup.
- **The page title's "Error: " prefix** (REPORT §3.7) is left to the page, which owns the title.
- **The defined edge is measured against all six palette colors**, counting the card's own surface for the dark ones (one line can't reach 3:1 against both the light page and the navy ink); the studio measured only the light grounds. `BACKDROP_FAMILIES[f].card.border` and `.rule` stay as brand constants, unused by the themed card (`rule` retired by E4).
- **The accent for icons is the primary button's color**, which reaches 3:1 on the card; UNC's Carolina Blue wouldn't.
- **Card width** is a CSS custom property, `--ak-card-width`, default 380px (E5, decided), in the optional styles only; the backdrop assumes the same width when it isn't given the card (`CARD_WIDTH`).
- **Times in emails** are Eastern clock times by default (`timeZone`, `timeZoneLabel` change it). Invites reply to the inviter; every other email replies to the help address.
- **A Super admin's override doesn't reach Cognito's own Reply-To** (the pool's email configuration, set at deploy), and the custom message trigger names the configured address unless the site gives it a reader. The app's own emails and screens follow the override.

## Consequences

- A site's sign-in page renders `SignIn` alone: the card, its footer, and "Trouble signing in?" are inside it (`data-backdrop-card` on the card). The template's own card wrapper, owner line, and footer go.
- Sites pass `help` (the effective address and the owner's name) and `theme` to the screens, and the same `codeLifetimeMinutes` to the preset and the screens.
- Tests and the copy deck pin the words; changing a string is a change to `copy.ts`, reviewed against the studio.

## Amendment 2026-10-19: the register's decisions

David's answers of 2026-10-19 settled the rows this record built as options. Each is now built as decided.

- **A6, the button words**, are decided as above; the sign-up code step's "Verify" became **Continue** (a step in between). They're constants in `copy.ts`, not options.
- **A7:** `codeLifetimeMinutes` defaults to **10** (Cognito's `AuthSessionValidity` follows it, and so do the screens, the code emails, and the simulated-code timing).
- **A10, emails:**
  - Every sender is a **reply-able `sign-in@` mailbox, never `noreply@`**, with the family's display name ("{Site} (NC OSBM)", "{Site} (UNC)", "{Site}"). The preset (`email.fromAddress`, `email.fromName`, and a new required `email.family`), `createSesInviteMailer`, the invite-expiry owner warnings, and the digest all refuse anything else (`senderProblems`, `siteSender`).
  - **Account-change notices are on by default:** "A passkey was added", "Your password was changed" (and "Your email address changed", which the email-change action already sent to the old address). Cognito has no trigger for a passkey or a password change, so the screens post to the site's notice route (`createAccountNoticeRoute`, `/api/auth-kit/account-notice`) right after the change; the route emails only the signed-in account's own address, checks a passkey notice against the account's passkeys, and is rate-limited. A notice is a courtesy, not a detection control: someone holding the session can skip the request.
  - The OSBM **authorized-use line is removed**, and nothing hooks MyNCID colours or an NCID slot.
- **E4a:** the admin alerts (a Super admin grant, an ownership transfer, a Manager's invite, a changed help address, the last owner's unused invite) use the shared layout and carry the footer like every other email (`createSesInviteMailer` takes `site: { siteName, theme, help }`).
- **E4c, the help address:** role mailboxes are the default. A person's own address is allowed only with an explicit per-site acknowledgement, `{ address, personal: true }` (the preset's `email.replyTo`, `createSignInHelp`, `authTheme`'s `helpAddress`, the custom message trigger, the owner warnings, the digest), and the Super admin's Settings override follows the same rule (an "on purpose" box, stored as `personal: true`). Open sign-up sites say "the {Site} team" and leave out the Teams line automatically.
- **E5, the card:** 380px wide; "Trouble signing in?" inside; the defined 3:1 edge; no monogram by default. `authTheme(family, { cardStyle })` picks one of Card Studio's five directions (`design/shared/sign-in-card.js`, `tokens()` and the `.d-*` rules; `cardStyleVariables`): **Quiet** (default), **Monogram** (the site's initials above the heading, warmer neutrals, rounder corners), **Frosted** (a translucent, blurred panel; solid where the browser can't blur), **Plain** (no card: a soft, readable column the backdrop fades into, the one exception to E4's no-fade rule; it has no edge to check), and **Porcelain** (layered shadows with a faint family glow, 20px corners, the other ways in on a tinted well).
- **A9:** every email field carries an envelope icon, hidden from screen readers.
- **F11:** the personal family lives on **yokum.app**: its sender is `sign-in@yokum.app` (`theme.senderAddress`), its default help mailbox `help@yokum.app` (so it's the one family that ships a help address; OSBM and UNC still ship none until their role mailboxes exist), and its sites `<name>.yokum.app`. yokumlab.com stays only as the Yokum Lab site's own domain.

## Amendment 2026-10-19: Continue opens the passkey prompt only where this browser remembers one

Register A5a (David, from the demo: a first-time user pressed Continue and met the browser's "no passkey found").

- **The email step.** Continue opens the passkey prompt only when this browser remembers a passkey sign-in for the typed address. Otherwise it goes to **"How do you want to sign in?"** ("for {email} · Change") with three options: **Use a passkey** (recommended; "Your face, fingerprint, or device PIN.": the prompt, with the decoy and the calm note when there's none, as before), **Use a password** (the password-field glyph), and **Email me a code** (the envelope; left out on pools without emailed codes). "Trouble signing in?" and the identity footer stay as on the other screens. Passkeys off: Continue still opens the password screen.
- **The same screens for every address** ([0018](0018-same-screens-for-every-address.md) holds): the choice comes from this browser alone, so the server sees nothing until the person chooses, and then the same requests it always did.
- **The hint** (`passkey-hint.ts`): this site's `localStorage` keeps salted SHA-256 hashes of normalized addresses (at most 20), with a random per-browser salt beside them; it's never sent to the server. It's set after a passkey sign-in and after creating a passkey (the first-credential chooser, the "Create a passkey on this device?" offer, My account). It's removed when My account removes the account's last passkey (auth-kit can't tell which device a passkey lives on, so removing one of several keeps it), and when someone the hint sent to the prompt chooses another way in twice in a row (that passkey isn't on this device any more). Blocked storage, or no Web Crypto, reads as no hint: the choice screen.
- **On a shared computer** the hint only changes which screen shows first for an address someone signed in with there. It reveals nothing a person at that computer couldn't learn by typing the address and pressing Continue (the hashes can be tested only by guessing addresses), proves nothing, and signs no one in.
- **Invites** still tell the invitee to choose **Email me a code** (the option on the choice screen, and the start of the email step's "Email me a code instead").

