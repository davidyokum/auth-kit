# 0020. Backdrops: site identity behind a fixed card

- **Status:** Accepted, 2026-10-18
- **Design:** the sign-in design report (passwords-flow `design/benchmark/REPORT.md`, kept privately): §1.3 "Brand the context, fix the mechanics", §7 "OSBM core, UNC and personal variants"

## Context

Every site's sign-in card is the same: the same fields, words, order, and layout (`SignIn`), so people learn it once and a look-alike has nothing new to offer. A family (OSBM, UNC, personal) changes a few colors, the owner line, and the footer. That leaves sites of one family nearly identical, and people who use several of them can't tell at a glance which one they're on.

The report's survey points one way: large systems lock the mechanics and let the organization change the context around them. Microsoft Entra lets a tenant change its logo, background, and a line of text, never the fields, and is retiring custom CSS to resist phishing. The card is the mechanism; the space behind it is context.

Security images ("SiteKey", "your personal picture") are the cautionary tale. Banks showed each customer a chosen image to prove the page was real; when researchers removed it, nearly everyone signed in anyway (23 of 25 participants in Schechter et al., "The Emperor's New Security Indicators", 2007). A picture can't authenticate a page: anyone can copy it, and people don't notice its absence.

## Decision

**A site's expression lives behind the card, as a backdrop, and it's for recognition and delight, not security.** No screen, email, or document will say "check the picture"; the card's heading names the site, and the domain is still the only thing that proves it.

- **Seeded and generative.** `auth-kit/backdrops` draws a backdrop from `{ style, seed, family }`: eight styles (magnetic dots, contours, flow lines, watercolor, aurora, stained glass, constellation, ripples) painted in the family's palette, plus `painted`, a slot for a finished image. A seed is any string; the same seed draws the same picture. No dependencies: a small seeded generator and simplex noise written into the package.
- **One module per style, one list.** A style is a folder (`styles/<id>/`) with its module (ID, label, interactivity, versions) and one file per version, each with its own palette mapping and renderer; `styles/registry.ts` lists them. Shared helpers (generator, noise, colors, scrim, frame loop, visibility and reduced-motion handling) live outside the styles, so a new style is one folder and one line. A style taken out of offer is marked `retired`, never deleted.
- **Rules enforced in code, not left to each style** (`renderBackdrop`):
  - reduced motion (the OS setting) draws one still frame, with no animation and no pointer response;
  - the loop stops while the tab is hidden or the canvas is off-screen;
  - at most 30 frames per second (each style sets its own; slow styles 6), at most 2 backing pixels per CSS pixel (soft styles 1-1.25), at most a 4K canvas; per-frame work allocates nothing (tests read the per-frame code and fail on allocation, and hold each style to a budget of canvas calls);
  - the canvas is `aria-hidden` and `pointer-events: none`; pointer effects come from passive window-level listeners, and taps on the card or any control never reach a style;
  - **the card stays solid.** A scrim, the page color at 94% over the art, covers the card and a 20px margin and fades out over 64-160px. `cardContrast(family)` proves the card's text, links, button, and focus ring meet WCAG 2.2 AA, and that the worst case of any palette color under the scrim is within 1.2:1 of the page. No text ever sits on the art: the owner line and footer are inside the card.
- **A site locks its backdrop.** The site's name only proposes a default (`defaultBackdrop(name)`). Once chosen, the site stores the literal `{ style, seed, styleVersion, locked: true }`; nothing is derived at build time, so renaming the site or changing the list of offered styles never changes it. The template's picker always writes a literal seed with `locked: true`, and its production builds fail while the backdrop isn't locked (`backdropLockProblems`).
- **Released style versions are frozen.** A later auth-kit could otherwise draw a locked seed differently. Each style version is its own file and never changes once released; a change in look is a new version beside it, and every version stays available, so a locked site draws exactly the same picture on every later auth-kit. The kernel it draws with (`kernel/v1/`: generator, noise, colors, composition helpers) is frozen the same way; changes go in `kernel/v2/`. `test/backdrops/frozen.json` pins a hash of what each version asks the canvas to draw (calls and arguments, recorded rather than rasterized, so it's the same on every machine) for a fixed seed, palette, and script of frames, and the test fails if a released hash changes or a released version disappears. Moving a site to a newer version is an explicit choice in the picker, which offers the same seed in the newest version side by side.
- **What isn't frozen, on purpose:** the family palettes (brand constants: a change is a brand decision for every site of the family, pinned by its own test) and the scrim and frame loop (they're the card's contract and the battery rules, applied to every style alike).

## Consequences

- Sites of one family look related (same card, same palette) and distinct (their backdrops), without any of them touching the card.
- Old style versions accumulate in the package. They're small (a few kilobytes each, tree-shaken where unused), and deleting one would redraw every site that locked it.
- A locked site needs an auth-kit that has its style version: a downgrade below the release that introduced it fails loudly (`resolveStyleVersion` throws) rather than drawing something else.
- The scrim makes the art fade into the page around the card. On a phone, where the card spans the width, the backdrop shows mainly above and below it.
- Backdrops cost a little battery while visible. Measured in headless Chromium at 1440×900 with software rendering (no GPU, so a ceiling): the heaviest frame (contours, at 6 per second) about 4 ms; most styles under 1.5 ms, the lightest 0.1 ms. The README has the table.
- The picker (`auth-kit/backdrops/picker`) carries a marker, and `check-prod-build` fails a production build that bundles it.
