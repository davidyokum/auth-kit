# 0025. Preview mode: the real card, held at any screen, inert

- **Status:** Accepted, 2026-10-19
- **Register:** E9 (passwords-flow `DECISIONS.md`, decided 2026-10-19): one Sign-in Studio that draws the real auth-kit card through a preview mode, shipped as a standalone file with each release; the same preview supplies the primer's walkthrough screens and auth-kit's screenshot tests.

## Context

Three things need to draw the sign-in card at any screen and state, without a user pool:

1. **The Sign-in Studio**, the design page where David reviews and votes on screens: a plain HTML page with no build step, hosted as a private claude.ai artifact.
2. **The primer's walkthrough**, which shows each screen a person meets.
3. **auth-kit's own screenshot tests**, so a styling regression fails the build. v0.1.9-alpha.1 shipped "How do you want to sign in?" with unstyled buttons; no test drew the screen.

Until now the Studio drew a hand-made copy of the card (Card Studio's `sign-in-card.js`). A copy drifts. The unstyled buttons looked fine in it, because the copy wasn't the code.

The real screens (`SignIn`, `SignUp`, `RequestAccess`, `SignedOutEverywhere`) are state machines that call Amplify, read and write this browser's storage, post to the site's routes, open the browser's passkey window, and navigate. To draw one at, say, "wrong password", something has to start it there and stop it from doing any of that.

Options considered:

1. **Keep a mock** and test it against the copy deck. It still isn't the code: styles, structure, and states can drift.
2. **Fork the components** into preview versions. The same drift, inside the repo.
3. **One seam in the real components**: a driver that can hold a component at a given state and turn its effects off. **Chosen.**

## Decision

**The screens get an injectable driver; preview mode is a driver that holds them and does nothing.** The components and their words are the live ones.

- **The driver** (`src/client/driver.ts`, React context) carries every effect the screens have: Amplify's calls, the passkey hint and the passkey offer (localStorage), the request form's hand-off (sessionStorage), the account-change notices and the sign-up and request posts (the site's routes), the breached-password check, the clipboard, and navigation. The default is the live driver, which calls exactly what the screens called before, so `auth-kit/client`'s API and behaviour don't change: no new props, and every existing test passes unchanged. The driver can also:
  - hold a component at a state (`initial`: a view, the values typed, an error or status). A held component starts no ceremony on mount (no passkey window, no `AssociateSoftwareToken`) and moves no focus.
  - name each control (`act(name, handler)`): the handler itself when live, a report in preview. Only the preview's handlers put `data-auth-kit-action` in the markup, so the live DOM is unchanged.
- **`auth-kit/preview`** (a subpath) draws a declarative spec: `{ screen, state, family, theme, cardStyle, cardEdge, accountCreation, inviteLine, remembered, site, help, sampleUser, device, … }`. It covers 27 screens and 52 states, using the Studio's `{ screen, state }` IDs plus the sign-in card's other views.
  - States come from the live words: the field checks (`ERRORS`) and Cognito's errors through the same `describeAuthError` the live card uses.
  - Every click or submit calls `onAction(name, info)`, and nothing else happens. `info.next` says where the live card would go. A test runs the live card, with Amplify mocked, through every screen's controls and checks `next` against where it lands.
  - `previewBackdrop` draws a backdrop from the registry. It never keeps a subject tour, since a tour writes localStorage.
- **The standalone file**, `auth-kit-preview.js`, is for pages with no build step. It's one classic script with React and ReactDOM inside, and it sets `window.AuthKitPreview = { version, screens, actions, render(host, spec) → { el, card, rect(), update(spec), actions(), focus(), destroy() }, renderBackdrop(host, options), … }` and injects the card's CSS. The backdrop styles' drawing code is in a second file, `auth-kit-preview-backdrops.js`, loaded only when a backdrop is drawn.
  - `scripts/build-preview.mjs` (esbuild) builds both into `release/`, never into `dist/`.
  - CI builds them from the tagged commit, puts them in `SHA256SUMS`, and attests them with the tarball (one `attest-build-provenance` step, [0012](0012-release-tarballs.md)). Then it attaches them to the GitHub Release beside the tarball.
  - `gh attestation verify auth-kit-preview.js --repo davidyokum/auth-kit` checks a copy.
- **Screenshot tests** (`test/screenshots`, Playwright) run against the standalone file in the Playwright container, where the baselines were taken.
  - Every screen and state × family × card style × light/dark page × desktop/phone (3,120 cards) is checked for unstyled controls, small targets, overflow, the device's width, and a heading. Each family has a computed-style baseline, with the base look in full and the other looks as diffs.
  - The same cards are measured for contrast (amended for v0.1.10-alpha.1, after the Sign-in Studio measured v0.1.10-alpha's card by hand): text 4.5:1, the focus ring and the boundaries of fields, outline buttons, and the card 3:1, each from the rendered card's computed colours composited over what is really behind it (the page, the card's fill, a tint or well, Plain's column, Frosted's see-through fill and its backdrop filter). Their primary buttons are checked against register A6: no step another step follows says "Create account", "Finish", or "Sign in" (also in every account-creation mode).
  - Every control on every screen is clicked in a real browser and must only report.
  - Every screen has an accessibility snapshot and a baseline image, and there are images of the choice screen in every family and style, on a phone, and on a dark page.
  - The release job waits for these tests.

### What "inert" guarantees

- **No Amplify or Cognito calls.** The preview's driver performs none. The standalone file contains neither Amplify nor the client's direct Cognito calls: the build replaces `src/client/api.ts` and `aws-amplify` with stubs whose functions refuse, and the build script fails if the file mentions Amplify or an AWS endpoint.
- **No network, no storage writes, no credentials, no clipboard, no navigation.** Every control reports (`onAction`) instead of acting, and every effect in the preview's driver refuses and calls `onEffect`, which tests watch and which never fires. Links and forms have their defaults prevented twice: by the control, and by the stage. Reads a held screen makes on mount (the step-up's signed-in address, the passkey hint) answer from the sample data.
- **A second wall in the standalone file.** At build time, `fetch`, `window.localStorage`, `window.sessionStorage`, `navigator.credentials`, `navigator.clipboard`, and `window.location.assign` in the bundled code are replaced with stand-ins: reads find nothing, and writes and requests are refused the way a browser refuses them, which the card's code already handles. So even a control the driver missed couldn't reach out.
- **The one request it makes**, and only when a backdrop is drawn: the backdrop styles file, from beside `auth-kit-preview.js` or from `AuthKitPreview.backdropsUrl`. A page that loads that file with its own `<script>` tag makes none. The `painted` style loads the image a host names.
- **Proven in tests:** the jsdom tests (every control on every screen, with `fetch`, storage, credentials, the clipboard, and Amplify spied) and the browser tests (every request refused and recorded, the same APIs wrapped before the preview loads, navigations recorded). A negative control, making the preview's controls act, fails them.

### Never in a site's bundle

- `auth-kit/preview` is its own subpath. Nothing else in the package imports it (a hygiene test checks), so a site that doesn't import it never bundles it.
- It carries `PREVIEW_MARKER`. `auth-kit check-prod-build` fails a production build that contains it, as it does the dev sign-in route and the backdrop picker.
- The standalone files are release assets only. They aren't in the npm tarball, and `check-tarball` refuses them.

### What the preview doesn't do

- **It has no dark card.** auth-kit's card is light, and its pages are light ([0021](0021-backdrops.md)). `theme: 'dark'` draws the real card on a dark page with `color-scheme: dark`. The card stays light; only the see-through Frosted style changes, thickening from 66% to 90% white so it keeps its contrast over the dark page (v0.1.10-alpha.1; any page that declares `color-scheme: dark` gets the same). The contrast tests prove every style passes on both pages.
- **Emails aren't drawn yet.** The Studio's three email screens (the invite, the sign-up code, "you already have an account") stay the Studio's own. `src/shared/emails.ts` renders them, so a `message` screen can come later.
- **It isn't a demo of the live flow.** A preview shows one state; a host follows `info.next` to draw the next one.

## Consequences

- The Studio and the primer draw the code itself, so a styling or wording change shows up there the day it ships, and the screenshot tests catch one that wasn't meant.
- **Every new control** in a screen goes through `driver.act(name, …)`, or the inert tests fail. A new action name joins `PREVIEW_ACTIONS` and, where it leads somewhere, the `next` table, which the parity test checks against the live card. **Every new effect** goes through the driver.
- **Screen and state IDs and action names are an API.** Hosts store them, so renaming one is a breaking change.
- **Baseline images change deliberately.** After a styling change, re-take them in the container (`playwright.config.ts` has the command) and review the diff. The computed-style baselines are text and show exactly which properties moved.
- **Cost:** the standalone file is about 390 KB minified (120 KB gzipped), about 206 KB of it React DOM; the build script checks budgets for it and for the 609 KB styles file. The type-declaration build now gets an explicit 8 GB heap: main already peaked at 4.6 GB, and the new entry crossed Node's default.
- The screenshot job's container tag must match the `@playwright/test` version, which is pinned exactly. A test checks both, so Dependabot's bump fails until the image tag moves with it.
