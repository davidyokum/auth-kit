# 0021. Backdrops: site identity behind a fixed card

- **Status:** Accepted, 2026-10-18
- **Design:** the sign-in design report (passwords-flow `design/benchmark/REPORT.md`, kept privately): §1.3 "Brand the context, fix the mechanics", §7 "OSBM core, UNC and personal variants"

## Context

Every site's sign-in card is the same: the same fields, words, order, and layout (`SignIn`), so people learn it once and a look-alike has nothing new to offer. A family (OSBM, UNC, personal) changes a few colors and the footer's identity line ([0024](0024-sign-in-copy-and-family-themes.md)). That leaves sites of one family nearly identical, and people who use several of them can't tell at a glance which one they're on.

The report's survey points one way: large systems lock the mechanics and let the organization change the context around them. Microsoft Entra lets a tenant change its logo, background, and a line of text, never the fields, and is retiring custom CSS to resist phishing. The card is the mechanism; the space behind it is context.

Security images ("SiteKey", "your personal picture") are the cautionary tale. Banks showed each customer a chosen image to prove the page was real; when researchers removed it, nearly everyone signed in anyway (23 of 25 participants in Schechter et al., "The Emperor's New Security Indicators", 2007). A picture can't authenticate a page: anyone can copy it, and people don't notice its absence.

## Decision

**A site's expression lives behind the card, as a backdrop, and it's for recognition and delight, not security.** No screen, email, or document will say "check the picture"; the card's heading names the site, and the domain is still the only thing that proves it.

- **Seeded and generative.** `auth-kit/backdrops` draws a backdrop from `{ style, seed, family }`: eight styles (magnetic dots, contours, flow lines, watercolor, aurora, stained glass, constellation, ripples) painted in the family's palette, plus `painted`, a slot for a finished image. A seed is any string; the same seed draws the same picture. No dependencies: a small seeded generator and simplex noise written into the package.
- **One module per style, one list.** A style is a folder (`styles/<id>/`) with its module (ID, label, interactivity, versions) and one file per version, each with its own palette mapping and renderer; `styles/registry.ts` lists them. Shared helpers (generator, noise, colors, frame loop, visibility and reduced-motion handling) live outside the styles, so a new style is one folder and one line. A style taken out of offer is marked `retired`, never deleted.
- **Rules enforced in code, not left to each style** (`renderBackdrop`):
  - reduced motion (the OS setting) draws one still frame, with no animation and no pointer response;
  - the loop stops while the tab is hidden or the canvas is off-screen;
  - at most 30 frames per second (each style sets its own: 6 to 30), at most 2 backing pixels per CSS pixel (soft styles 1-1.25), at most a 4K canvas; per-frame work allocates nothing (tests read the per-frame code and fail on allocation, and hold each style to a budget of canvas calls);
  - the canvas is `aria-hidden` and `pointer-events: none`; pointer effects come from passive window-level listeners, and taps on the card or any control never reach a style;
  - **the backdrop stays fully present, and the card carries its own contrast.** Nothing fades, vignettes, or veils the art around the card (an early version had a scrim; David found it odd, and it made every style look fogged). The card is opaque white with a crisp 1px border in a family-tinted dark and a soft shadow; since [0024](0024-sign-in-copy-and-family-themes.md) the border is computed (`definedCardEdge`, the theme's `cardEdge: 'defined'`) rather than picked by hand. `cardContrast(family)` proves the card's text, links, button, and focus ring meet WCAG 2.2 AA, and that the card's edge (its border or its surface) reaches 3:1 against every color the family's backdrops paint with (WCAG 1.4.11), so the outline holds wherever it lands on the art. No text ever sits on the art: the footer's identity line is inside the card, and nothing sits above the heading (register E4; [0024](0024-sign-in-copy-and-family-themes.md)).
  - **light and slow.** Every palette is a light page with brand tints (dark fields read as severe), and motion is slow: drift, waves, and orbits take tens of seconds to minutes, so nothing pulls the eye from the form.
- **A site locks its backdrop.** The site's name only proposes a default (`defaultBackdrop(name)`). Once chosen, the site stores the literal `{ style, seed, styleVersion, locked: true }`; nothing is derived at build time, so renaming the site or changing the list of offered styles never changes it. The template's picker always writes a literal seed with `locked: true`, and its production builds fail while the backdrop isn't locked (`backdropLockProblems`).
- **Released style versions are frozen.** A later auth-kit could otherwise draw a locked seed differently. Each style version is its own file and never changes once released; a change in look is a new version beside it, and every version stays available, so a locked site draws exactly the same picture on every later auth-kit. The kernel it draws with (`kernel/v1/`: generator, noise, colors, composition helpers) is frozen the same way; changes go in `kernel/v2/`. `test/backdrops/frozen.json` pins a hash of what each version asks the canvas to draw (calls and arguments, recorded rather than rasterized, so it's the same on every machine) for a fixed seed, palette, and script of frames, and the test fails if a released hash changes or a released version disappears. Moving a site to a newer version is an explicit choice in the picker, which offers the same seed in the newest version side by side.
- **What isn't frozen, on purpose:** the family palettes (brand constants: a change is a brand decision for every site of the family, pinned by its own test) and the frame loop (the battery rules, applied to every style alike).

## Consequences

- Sites of one family look related (same card, same palette) and distinct (their backdrops), without any of them touching the card.
- Old style versions accumulate in the package. They're small (a few kilobytes each, tree-shaken where unused), and deleting one would redraw every site that locked it.
- A locked site needs an auth-kit that has its style version: a downgrade below the release that introduced it fails loudly (`resolveStyleVersion` throws) rather than drawing something else.
- The art runs right up to the card's border. On a phone, where the card spans the width, the backdrop shows mainly above and below it.
- Backdrops cost a little battery while visible. Measured in headless Chromium at 1440×900: the busiest styles take 27-35 ms of main-thread time per second (contours at 4.5 ms a frame, 6 frames a second; flow lines 1.7 ms at 20; magnetic dots 1 ms at 30), about 3% of one core; the rest stay under 13 ms a second. The README has the table. Nothing runs while the tab is hidden, the canvas is off-screen, or reduced motion is on.
- The picker (`auth-kit/backdrops/picker`) carries a marker, and `check-prod-build` fails a production build that bundles it.
