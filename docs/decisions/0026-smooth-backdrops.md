# 0026. Smooth backdrops: up to 60 frames a second, and Contours v2 follows the pointer

- **Status:** Accepted, 2026-10-22
- **Amends:** [0021](0021-backdrops.md)'s frame-rate cap (30 frames a second; each style 6 to 30).

## Context

David found the first site's backdrop (Contours v1) jittery, and expected it to respond to the mouse. Both were by design in 0021:

- Contours v1 draws **6 frames a second**, so its lines step instead of glide. The renderer capped every style at 30, and several sit lower (Aurora and Stained Glass 15, Flow Lines 20, Constellation and Ripples 24, which also alternates two and three refreshes on a 60 Hz display, a visible stutter).
- Contours' `interactivity` was `'none'`.

The low caps saved battery and main-thread time. They cost what the art is for: a page that feels alive and calm, not one that twitches.

## Decision

- **The renderer allows up to 60 frames a second** (`MAX_FPS`, `styles/define.ts`), when a style version asks for it. Every rule of 0021 that keeps a backdrop cheap still holds: reduced motion draws one still frame with no pointer response; the loop stops while the tab is hidden or the canvas is off-screen; a device that saves data, reports 2 GB of memory or less, or averages more than 12 ms a frame over the first 30 frames draws the still frame; per-frame work allocates nothing; each style keeps its budget of canvas calls.
- **Contours v2** (`styles/contours/v2.ts`): v1's map at the display's rate (up to 60), with a soft hill that rises under the pointer, its contours ringing around it, eased in and out by the renderer. To keep a frame cheap at 60, the noise terrain is sampled as keyframes every half second and each frame blends the two around it; the next keyframe is computed a few rows per frame ahead of need. The picture at any time depends on that time alone, so stills and the frozen hash are exact. Measured at 1440 × 900 in Chromium: about 3 ms a frame, 60 frames a second.
- **Contours' `interactivity` becomes `'pointer'`.** v1 ignores the pointer, so locked v1 sites draw exactly what they drew; they only gain the window-level passive listeners, which do nothing for v1.
- **Released versions stay frozen** (0021): v1 is unchanged and keeps its hash. Sites move to v2 by changing `styleVersion` in `site.config.ts` (the picker offers the upgrade).

## Consequences

- Other slow styles get smooth versions only after David has seen Contours v2 (his choice, 2026-10-22), so they share one feel.
- A 60-frame style uses more power than a 6-frame one while the page is open and visible. The slow-device and hidden-tab rules bound it.
