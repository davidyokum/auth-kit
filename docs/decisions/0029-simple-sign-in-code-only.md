# 0029. Simple sign-in: an emailed code every time, and nothing else

- **Status:** Accepted, 2026-11-19
- **Amends:** [0001](0001-passkey-first.md) (a site may now have no passkeys at all), [0024](0024-sign-in-copy-and-family-themes.md) (the first credential is required on Full sites only), and the template's setup questions.

## Context

Some sites are small and short-lived: a cohort's agenda, a talk's materials, a members' page. The people who use them sign in a handful of times. For them, Full sign-in costs more than it gives:

- **Every account must set up a passkey or a password after its first code** (ADR 0024). For someone visiting twice, that's a step nobody needs, and the most common place a first visit stalls.
- **A password brings an authenticator app** (register A2). That's the right rule for a password, and a lot to ask of a reader of an agenda.
- **The help screens are mostly about passkeys, passwords, and authenticators.** On a site where nobody has those, they're noise.

The owner already controls who gets in: the invite list on the People page, where an admin removes an address. The emailed code proves the person holds that inbox. That's enough for these sites.

## Decision

Each site picks one of two sign-in modes, named everywhere the mode is named (setup, Studio, the README, the sites log):

- **Full: code, passkey, password** (the default, and every site made before this).
- **Simple: code only.** Enter your email, get a code, enter it, you're in. No passkeys, no passwords, no authenticator apps, no SMS.

One setting, `signIn`, carries it, in the template's `site.config.ts`, and the same value goes to the preset, the server, the sign-in card, My account, and the mailer: `{ mode: 'full' }` or `{ mode: 'simple', stay }`. `stay` is how long a sign-in lasts on one device, counted from the sign-in: `'browser'` (until the browser quits) or a whole number of days, 1 to the tier's ceiling (30 on Tier 2, 1 on Tier 3). Setup asks it right after the mode: every visit, 7 days, 30 days (the default), or another number.

### What Simple changes

- **The pool** (`auth-kit/amplify`): `AllowedFirstAuthFactors` is `['EMAIL_OTP']` alone, and no WebAuthn settings. The app client's refresh token lasts the `stay` (`'browser'`: 12 hours, the backstop behind cookies that end with the browser). `refreshTokenMinutes` can't be set alongside it. An admin pool can't be Simple, and neither can `accountCreation` `domains` or `open` (their sign-up page asks for a passkey or a password): Simple is invite only, with `request` allowed (an approved request is an invite).
- **The server** (`createServerAuth({ signIn })`): `requireFirstCredential` defaults to off, since an emailed code is everyone's only credential, and `true` with Simple is refused (it would lock everyone out). This is not the matrix override: it needs no environment flag. The authenticator rule for passwords stays on (a Simple pool takes no passwords, so it never applies).
- **The card** (`<SignIn signIn={…} />`): the email step's button is "Email me a code" and sends it, for every address alike (nothing about the account is revealed, as ADR 0018 requires). No other way in is offered, even where the browser remembers a passkey. The code is the whole sign-in: no factor read, no passkey offer, no first-credential step. Under the code field: "No email after a minute? Check your spam or junk folder, then send a new code." "Trouble signing in?" lists only "I didn't get a code", "I can't get into my email", and "Something else", and none of the card's words name a passkey, a password, or an authenticator app.
- **My account**: no passkey, authenticator, or password sections, and none of them are read. A "How you sign in" section says "You sign in with a code we email you. There's nothing else to set up." and "You stay signed in on this device for 30 days." (or "until you quit your browser").
- **The invite**: step 3 is "Enter the 8-digit code we email you. That's all: there's no password or app to set up." (`createSesInviteMailer({ site: { signIn } })`, or `createPeopleActions({ signIn })`).
- **"Every visit"** (`stay: 'browser'`): the token cookies carry no `Max-Age` and no `Expires`, so they end when the browser quits. In the browser, `configureAuthClient(outputs, { cookies: 'browser' })`. On the server, `amplifyAdapterRefresh(deps, { cookies: 'browser' })` strips the lifetime from the cookies Amplify's server adapter writes (it would otherwise give them 365 days); deletions are left alone, so sign-out still clears them. Browsers that restore a session on restart may keep the cookies; the 12-hour refresh token is the ceiling either way.
- **Preview mode**: `signIn` in the spec draws the Simple card. `PREVIEW_SIMPLE_SCREENS` lists the screens a Simple site has; naming another throws.

`signInSession(signIn, tier)` returns the refresh-token minutes and whether the cookies end with the browser, so the preset, `amplifyCookieRuntimeOptions`, and `configureAuthClient` read one answer.

### Also in this change, for every site

- **"Add several at once" on the People page** (`people.inviteMany`, `forms.inviteMany`, `<InviteManyForm>`, or `inviteMany` on `<InviteForm>`): up to 50 pasted addresses (commas, semicolons, new lines, or `Name <address>`), as Member or one of the site's own roles. Admin roles stay one person at a time (a reason and a recent sign-in). Each address is the ordinary invite: its own checks, its own audit entry, its own email. Nothing is sent when an entry isn't an address or the list is too long, or when an address is outside the usual domains and that isn't confirmed. An address that already has an account is skipped and named; a failure stops the rest, and the result says which weren't sent.

### Choices David made (2026-11-19)

1. Admins sign in by code too, on the same pool. The admin area's own rules (live checks, recent sign-in for changes) still apply.
2. "Every visit" is browser-session cookies with a 12-hour refresh-token backstop.
3. Unused invites still expire after 7 days.
4. After a switch to Full, the passkey-or-password step is required (Full's rule).
5. The People page gets "Add several at once".
6. Removing someone reaches ordinary pages within 60 minutes, as on Full: disabling signs them out everywhere at once, and an access token already issued lasts until it expires. Admin pages check live.

## Moving between modes

**Simple to Full** is a settings change and a deploy. CloudFormation updates the pool's sign-in policy and WebAuthn settings and the app client's refresh-token lifetime without replacing either (a test checks that only those properties change), so every account stays and the emailed code keeps working. Each person's next sign-in then asks them to set up a passkey or a password, because Full requires it.

**Full to Simple isn't offered.** An account with an authenticator app can't receive emailed codes (Cognito's rule), so on a pool that takes only emailed codes it would be locked out. A site that wants Simple starts Simple.

## Consequences

- A Simple site's sign-in is: open the page, type the address (or follow the invite, which fills it in), press Email me a code, type the code.
- The security of a Simple site is the security of its members' inboxes. That's stated in setup, and it's why Simple isn't offered for the admin pool or for open sign-up.
- No stored passwords or authenticator secrets exist on a Simple pool, so there's nothing to reset; "lost my authenticator" and "forgot my password" disappear as support requests.
- Sites made before this keep Full and change nothing until they set `signIn`.
