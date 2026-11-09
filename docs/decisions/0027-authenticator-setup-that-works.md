# 0027. Authenticator setup that works: a QR code built in, Copy that copies, the setup link on phones only

- **Status:** Accepted, 2026-11-09
- **Amends:** [0024](0024-sign-in-copy-and-family-themes.md)'s "No QR renderer ships".

## Context

David set up the authenticator on the first real auth-kit site (PMA Event Series, on its preview) and couldn't finish without help:

- **No QR code.** auth-kit left the QR to each site (`renderQrCode`, to stay dependency-free), and the template passed none, so no site had one. The screen showed a 52-character setup key with nothing to scan.
- **Copy didn't copy.** His browser refused `navigator.clipboard.writeText`, and auth-kit had no fallback, so the card said "Couldn't copy here."
- **"On this device? Open the setup link." did nothing.** An `otpauth://` link opens an app only where one is registered for it: phones and tablets with an authenticator app. On a computer it goes nowhere.

Every site would have shipped the same screen.

## Decision

- **auth-kit draws the QR code itself** (`src/client/qr.tsx`): the `otpauth://` link as an inline SVG of dark squares (no raw HTML, no image request, nothing the nonce CSP must allow). The encoder is vendored, not a dependency: qrcode-generator 2.0.4 (Kazuhiko Arase, MIT; THIRD_PARTY_NOTICES.md) in `src/client/vendor/`, loaded on first use in its own chunk, so only this screen pays for it. `renderQrCode` still draws a site's own; `renderQrCode={false}` turns the QR off (the intro then speaks of the setup key). Every component that shows the setup screen passes `false` through.
- **Copy falls back** to selecting the key in an off-screen field and running the browser's copy command, inside the same click, when the async clipboard is refused or missing. "Couldn't copy here" shows only when both fail.
- **The setup link shows on touch devices only** (`(pointer: coarse)`, through the driver's `isTouchDevice`, decided after the first paint so server and browser HTML agree). Preview mode holds screens as a phone shows them, so its screens and screenshots keep the link.

## Consequences

- Every site gets a scannable QR code with no work, which is what makes the password path bearable. Passkeys stay the better path, and still wait for a site's final domain (0001).
- The client bundle gains a lazily loaded chunk of about 50 KB, fetched only when someone sets up an authenticator.
- `renderQrCode`'s type widens to `((uri) => ReactNode) | false`: existing sites keep working, and sites that passed their own renderer may now drop it.
