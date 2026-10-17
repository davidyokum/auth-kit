# 0018. The sign-in screens are the same for every address until a factor is proven

- **Status:** Accepted, 2026-10-17 (amends [0008](0008-client-in-the-browser.md))
- **Standard:** 03 §2 Sign-in ("keep account enumeration protection on, so the sign-in page doesn't reveal who has an account")

## Context

The pool has `PreventUserExistenceErrors` on, but that setting changes what Cognito says, not what the screens do with it. With choice-based sign-in (`USER_AUTH`), Cognito's answer to a first-factor request depends on the account:

- **Documented.** A request whose preferred challenge the account can't use gets `SELECT_CHALLENGE` with the challenges it can use. Someone with an authenticator (TOTP) turned on can't use an emailed code in an MFA-optional pool. For an address with no account, AWS says Cognito answers choice-based requests with "a random selection from the challenge types allowed for the user pool": a passkey, one-time password, or password challenge.
- **Seen on the 2026-10-17 demo deploy.** An unknown address asked with no preference got `SELECT_CHALLENGE` with `[PASSWORD_SRP, PASSWORD, WEB_AUTHN]`, no `EMAIL_OTP`; asked for a passkey, it got a `WEB_AUTHN` challenge listing decoy credential IDs. One address, one sitting.
- **Inferred, not yet seen live.** An unused invite has no password, passkey, or authenticator, so its only factor is the emailed code: a passkey or password request gets `SELECT_CHALLENGE` with `[EMAIL_OTP]`, and a code request sends a code. A passkey-only account gets `[WEB_AUTHN, EMAIL_OTP]` for a password request.

`SignIn` showed those answers directly. After a passkey or password request it showed "Choose how to sign in" with the account's own factors, and "Check your email" with Cognito's masked address only when a code was really sent. So anyone typing addresses into the sign-in page could tell an unused invite (only "Email me a code"), a passkey account, and an address with no account apart. The design benchmark's identifier-first flow ("show only the ways Cognito offers for this account") has the same problem.

## Decision

Until someone proves a factor, every screen and message depends only on what they typed and clicked:

- **Passkey.** If Cognito sends a passkey challenge, Amplify runs the prompt. If it says the account has no passkey, the browser shows a passkey prompt anyway (`decoyPasskeyPrompt`: random credential IDs, so nothing matches, and Amplify's error names). Either way the person sees the browser's sheet, and closing it gives the same message.
- **Password.** If the account has no password (Cognito offers a choice instead), the person gets Cognito's own wrong-password answer, "That email and password don't match."
- **Emailed code.** "Check your email" always follows, naming the address they typed (never Cognito's masked one, which an unknown address doesn't have): "If {address} has an account here, we've emailed it an 8-digit code." When nothing was sent, a typed code gets the wrong-code message after a round trip's delay, and the expired-session message after 3 minutes, as a real code would (`answerSimulatedCode`; it never calls Cognito). The screen also says what's true for everyone: accounts with an authenticator app can't get emailed codes.
- **No method chooser.** `SignIn` never shows Cognito's `SELECT_CHALLENGE` list. `isFirstFactorUnavailable(method, step)` decides when an answer means "not available to this account"; it's exported, with the two helpers, for sites building their own screens.

After a factor is proven (a passkey, the right password, a real code), the screens follow the account: the authenticator code, setup, the first credential after an invite.

## Consequences

- **Cognito's responses still differ, on the wire.** Anyone reading the browser's network panel, or calling `InitiateAuth` directly with the public client ID, sees the challenges Cognito returns. The screens can't hide that and only AWS can change it. The WAF sign-in rule ([0017](0017-per-rule-waf-modes.md)) limits how fast one address can ask (100 per 5 minutes once it blocks). This decision closes the casual route: a person, or a coworker, typing addresses into the page.
- **A small cost for real accounts.** Someone with only a password who clicks "Sign in with a passkey" sees a passkey prompt that can't succeed, then picks their password. An invitee who tries a password is told it doesn't match, and the message says to try another way. Someone with an authenticator who asks for a code is told how codes work rather than shown other methods.
- **The code screen is conditional** ("If … has an account here"), like the password-reset screen, instead of the benchmark's "We sent an 8-digit code to …". That wording is the price of not lying to an unknown address.
- **To check live** (the first real sign-in on the demo, and on each new pool): with the browser's network panel open, note the `InitiateAuth` responses for an invited address and for a few unknown addresses (several, since AWS calls the unknown-address answer random). Record the `AvailableChallenges` each gets with no preference, and what `PREFERRED_CHALLENGE=EMAIL_OTP` returns for an unknown address (a choice, or a fake code challenge with a masked destination). The screens are the same either way; the record says how much the wire reveals.
