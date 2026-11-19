/**
 * The card never covers the site's name (0.1.18). Yokum magnetic letters the site's name in the band
 * above the card (below it on phones) and lays it out around the card's box. Until 0.1.18 it did that
 * once, around the first (email) card, so a taller later screen grew over the name. Now the renderer
 * lays the art out again when the card's box changes (`followsCard`), and the site's scene keeps the
 * card's top where it was (it grows down).
 *
 * Here: every sign-in and help screen, in one card that changes in place as a live sign-in does, on the
 * magnetic backdrop, in a scene laid out as the starter template's (app/globals.css, `.auth-scene-content`;
 * keep the two in step), at desktop and phone sizes. For each screen:
 *
 * - the art was laid out around the card as it is now (not the email card);
 * - the name, when the art shows it, is clear of the card (8px or more);
 * - when it doesn't (no room around a tall card), the card's own heading names the site;
 * - the card's top is where the email card's was.
 */
import { expect, test } from '@playwright/test';
import { FONT, openHarness } from './harness.js';

/** The starter template's scene (app/globals.css), with the preview's stage reduced to a plain wrapper. */
const SCENE_CSS = `
html, body { margin: 0; }
body { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
#scene { flex: 1 0 auto; display: flex; flex-direction: column; color-scheme: light; }
#content { position: relative; z-index: 1; flex: 1 0 auto; display: grid; justify-items: center; align-items: start; padding: max(56px, calc((100dvh - 450px) / 2)) 16px 72px; }
@media (max-width: 480px) { #content { padding: 24px 16px 40px; } }
#content [data-auth-kit-preview] { padding: 0; width: 100%; max-width: var(--ak-card-width, 380px); }
`;

const SITES = ['Atlas', 'Example Reports', 'Regional Partners Portal'] as const;
const VIEWPORTS = [
  { width: 1280, height: 800, device: 'desktop' },
  { width: 1440, height: 900, device: 'desktop' },
  { width: 1366, height: 657, device: 'desktop' },
  { width: 1920, height: 1080, device: 'desktop' },
  { width: 390, height: 844, device: 'phone' },
  { width: 375, height: 667, device: 'phone' },
  { width: 430, height: 932, device: 'phone' },
] as const;

interface SceneArgs {
  site: string;
  device: 'desktop' | 'phone';
  font: string;
  css: string;
}

/** Runs in the page: walks one card through every sign-in screen on the magnetic backdrop. */
async function walk(arg: SceneArgs): Promise<{ checked: number; problems: string[] }> {
  const P = window.AuthKitPreview;
  const style = document.createElement('style');
  style.textContent = arg.css;
  document.head.append(style);
  document.body.replaceChildren();
  const scene = document.createElement('div');
  scene.id = 'scene';
  const content = document.createElement('div');
  content.id = 'content';
  scene.append(content);
  document.body.append(scene);

  const spec = (screen: string, state: string, remembered: boolean) => ({ screen, state, remembered, family: 'personal' as const, site: { name: arg.site }, device: arg.device, font: arg.font });
  const card = P.render(content, spec('email', 'typed', false));
  const backdrop = P.renderBackdrop(scene, { style: 'yokum-magnetic', seed: 'scene', family: 'personal', siteName: arg.site, still: true });
  await backdrop.ready;
  const settle = async () => {
    // The card's box changes in a ResizeObserver callback; the art follows once it settles (120 ms).
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 260));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  };
  await settle();
  const emailTop = card.rect(scene).y;

  const screens = P.screens.filter((s) => s.component === 'sign-in');
  const problems: string[] = [];
  let checked = 0;
  for (const s of screens) {
    for (const st of s.states) {
      for (const remembered of s.id === 'passkey' ? [false, true] : [false]) {
        card.update(spec(s.id, st.id, remembered));
        backdrop.update({});
        await settle();
        checked++;
        const where = `${s.id}/${st.id || 'default'}${remembered ? ' (passkey remembered)' : ''}`;
        const live = card.rect(scene);
        const layout = backdrop.layout();
        if (!layout) {
          problems.push(`${where}: the backdrop has no layout`);
          continue;
        }
        const off = Math.max(Math.abs(layout.card.x - live.x), Math.abs(layout.card.y - live.y), Math.abs(layout.card.width - live.width), Math.abs(layout.card.height - live.height));
        if (off > 4) problems.push(`${where}: the art was laid out around a card at ${JSON.stringify(layout.card)}, not the card at ${JSON.stringify(live)}`);
        if (Math.abs(live.y - emailTop) > 1 && live.height > 0) problems.push(`${where}: the card's top moved from ${emailTop} to ${live.y}`);
        const name = layout.siteName;
        const heading = card.heading;
        if (name) {
          const gap = 8;
          const clear = name.x + name.width + gap <= live.x || live.x + live.width + gap <= name.x || name.y + name.height + gap <= live.y || live.y + live.height + gap <= name.y;
          if (!clear) problems.push(`${where}: the card (${JSON.stringify(live)}) covers the name (${JSON.stringify(name)})`);
          if (scene.getAttribute('data-backdrop-site-name') !== 'shown') problems.push(`${where}: the art shows the name, but the card wasn't told`);
        } else {
          if (scene.hasAttribute('data-backdrop-site-name')) problems.push(`${where}: the art left the name out, but the card still hides it`);
          const visible = [...card.el.querySelectorAll('[data-auth-kit-slot="heading"] *, [data-auth-kit-slot="heading"]')].some((el) => getComputedStyle(el).position !== 'absolute' && (el.textContent ?? '').includes(arg.site));
          // The step-up heading ("Confirm it’s you") never names the site, by design.
          if (s.id === 'email' && st.id !== 'reauth' && !visible) problems.push(`${where}: no room for the name around the card, and the heading ("${heading}") doesn't name the site`);
        }
      }
    }
  }
  backdrop.destroy();
  card.destroy();
  return { checked, problems };
}

for (const viewport of VIEWPORTS) {
  test(`the card never covers the site's name: ${viewport.width}×${viewport.height} (${viewport.device})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { errors } = await openHarness(page);
    for (const site of SITES) {
      const result = await page.evaluate(walk, { site, device: viewport.device, font: FONT, css: SCENE_CSS });
      expect(result.checked, site).toBeGreaterThan(15);
      expect(result.problems, site).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}
