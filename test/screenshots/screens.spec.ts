/**
 * Baselines for preview mode, from the standalone file:
 *
 * - every screen and state, as an accessibility snapshot (the structure and the words, `.aria.yml`) and an
 *   image, on the OSBM family's Quiet card (it names an owner, so every help line shows);
 * - "How do you want to sign in?" (the screen that shipped unstyled in v0.1.9-alpha.1) in every family and
 *   card style, on a phone, and on a dark page, as images;
 * - the words that change with the site's settings and family, as accessibility snapshots;
 * - two backdrops behind the card, as still images.
 *
 * Images are compared pixel for pixel, so take them in the Playwright container (see playwright.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { PREVIEW_SCREENS } from '../../src/preview/screens.js';
import type { PreviewSpec } from '../../src/preview/spec.js';
import { FONT, openHarness } from './harness.js';

async function draw(page: Page, spec: PreviewSpec) {
  await openHarness(page);
  await page.evaluate((s) => {
    window.card = window.AuthKitPreview.render(document.getElementById('host')!, s);
  }, spec);
  return page.locator('[data-auth-kit-preview]');
}

const name = (screen: string, state: string) => `${screen}--${state || 'default'}`;

test.describe('every screen and state', () => {
  for (const s of PREVIEW_SCREENS) {
    for (const st of s.states) {
      test(name(s.id, st.id), async ({ page }) => {
        const stage = await draw(page, { screen: s.id, state: st.id, family: 'osbm', ground: true, font: FONT, ...(s.id === 'request-access' && { accountCreation: 'request' }) });
        await expect(stage).toMatchAriaSnapshot({ name: `${name(s.id, st.id)}.aria.yml` });
        await expect(stage).toHaveScreenshot(`${name(s.id, st.id)}.png`);
      });
    }
  }
});

test.describe('the choice screen in every family and card style', () => {
  for (const family of ['osbm', 'unc', 'personal'] as const) {
    for (const cardStyle of ['quiet', 'monogram', 'frosted', 'plain', 'porcelain'] as const) {
      test(`${family} ${cardStyle}`, async ({ page }) => {
        const stage = await draw(page, { screen: 'choose', family, cardStyle, ground: true, font: FONT });
        await expect(stage).toHaveScreenshot(`choose--${family}-${cardStyle}.png`);
      });
    }
    test(`${family} on a phone`, async ({ page }) => {
      const stage = await draw(page, { screen: 'choose', family, device: 'phone', ground: true, font: FONT });
      await expect(stage).toHaveScreenshot(`choose--${family}-phone.png`);
    });
    test(`${family} on a dark page`, async ({ page }) => {
      const stage = await draw(page, { screen: 'choose', family, theme: 'dark', ground: true, font: FONT });
      await expect(stage).toHaveScreenshot(`choose--${family}-dark.png`);
    });
  }
});

test.describe('the words that follow the site and family', () => {
  const variants: [string, PreviewSpec][] = [
    ['email--request', { screen: 'email', accountCreation: 'request' }],
    ['email--domains', { screen: 'email', accountCreation: { mode: 'domains', domains: ['example.org', 'example.gov'] } }],
    ['email--open', { screen: 'email', accountCreation: 'open' }],
    ['email--invite-sentence', { screen: 'email', inviteLine: 'sentence' }],
    ['email--no-passkeys', { screen: 'email', passkeysEnabled: false }],
    ['sign-up--open', { screen: 'sign-up', accountCreation: 'open' }],
    ['sign-up--not-allowed-requests', { screen: 'sign-up', state: 'not-allowed', accountCreation: { mode: 'domains', domains: ['example.org'], requestsAlso: true } }],
    ...(['unc', 'personal'] as const).flatMap((family): [string, PreviewSpec][] => [
      [`help-totp--${family}`, { screen: 'help', state: 'totp', family }],
      [`help-code--${family}`, { screen: 'help', state: 'code', family }],
      [`help-else--${family}`, { screen: 'help', state: 'else', family }],
      [`access-help--${family}`, { screen: 'access-help', family }],
    ]),
  ];
  for (const [label, spec] of variants) {
    test(label, async ({ page }) => {
      const stage = await draw(page, { family: 'osbm', font: FONT, ...spec });
      await expect(stage).toMatchAriaSnapshot({ name: `${label}.aria.yml` });
    });
  }
});

test.describe('backdrops behind the card (still frames)', () => {
  for (const [style, extra] of [
    ['contours', {}],
    ['county-survey', { subject: { rotation: 'fixed', key: 'Dare' } }],
  ] as const) {
    test(style, async ({ page }) => {
      await openHarness(page);
      await page.evaluate(
        async ({ style, extra, font }) => {
          const scene = document.createElement('div');
          scene.id = 'scene';
          scene.style.cssText = 'position: relative; width: 760px; display: grid; place-items: center;';
          document.getElementById('host')!.append(scene);
          window.AuthKitPreview.render(scene, { screen: 'choose', family: 'osbm', font });
          await window.AuthKitPreview.renderBackdrop(scene, { style, seed: 'k3f9x2ab', family: 'osbm', still: true, ...extra }).ready;
        },
        { style, extra, font: FONT },
      );
      await expect(page.locator('#scene')).toHaveScreenshot(`backdrop--${style}.png`);
    });
  }
});
