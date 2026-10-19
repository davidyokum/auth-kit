/**
 * Inert in a real browser (ADR 0025): every control on every screen is clicked (and every form submitted),
 * and the only thing that happens is a report. No request leaves the page,
 * nothing is stored, no credential, clipboard, or cookie API is touched, the page never navigates, and the
 * card stays where it was. Backdrops load only their styles file, once, and store nothing.
 */
import { expect, test } from '@playwright/test';
import { PREVIEW_SCREENS } from '../../src/preview/screens.js';
import { exitsUsed, FONT, openHarness } from './harness.js';

const STATES = PREVIEW_SCREENS.flatMap((s) => s.states.map((st) => ({ screen: s.id, state: st.id })));

test('every control on every screen reports, and nothing else happens', async ({ page }) => {
  const { requests, navigations, errors } = await openHarness(page);
  const result = await page.evaluate(
    ({ states, font }) => {
      const P = window.AuthKitPreview;
      const problems: string[] = [];
      const effects: string[] = [];
      let used = 0;
      const card = P.render(document.getElementById('host')!, { screen: 'email', font });
      for (const { screen, state } of states) {
        const reported: string[] = [];
        card.update({
          screen,
          state,
          family: 'osbm',
          font,
          ...(screen === 'request-access' && { accountCreation: 'request' as const }),
          onAction: (name: string) => reported.push(name),
          onEffect: (name: string) => effects.push(name),
        });
        const where = `${screen}/${state}`;
        const stage = card.el;
        const at = () => `${stage.getAttribute('data-auth-kit-preview-screen')} ${stage.querySelector('[data-auth-kit]')?.getAttribute('data-auth-kit-view')} ${stage.querySelector('[data-auth-kit="choose-first-credential"]')?.getAttribute('data-auth-kit-view') ?? ''} ${stage.querySelector('[data-auth-kit-slot="heading"]')?.textContent}`;
        const before = at();
        const listed = card.actions().map((a) => a.name);
        for (const el of stage.querySelectorAll<HTMLElement>('button, a[href], form')) {
          if (el instanceof HTMLButtonElement && (el.disabled || el.getAttribute('data-auth-kit-slot') === 'showButton')) continue;
          if (el instanceof HTMLAnchorElement && el.getAttribute('href')!.startsWith('#')) continue;
          const count = reported.length;
          if (el instanceof HTMLFormElement) {
            const submit = el.querySelector<HTMLButtonElement>('button[type="submit"]');
            if (!submit) continue;
            el.requestSubmit(submit);
          } else if (el.getAttribute('type') === 'submit') continue;
          else el.click();
          used++;
          if (reported.length !== count + 1) problems.push(`${where}: ${el.outerHTML.slice(0, 100)} reported ${reported.length - count} actions`);
          else if (!listed.includes(reported.at(-1)!)) problems.push(`${where}: reported "${reported.at(-1)}", which actions() doesn't list`);
        }
        if (at() !== before) problems.push(`${where}: moved from "${before}" to "${at()}"`);
      }
      card.destroy();
      return { problems, effects, used };
    },
    { states: STATES, font: FONT },
  );
  expect(result.problems).toEqual([]);
  expect(result.effects).toEqual([]);
  expect(result.used).toBeGreaterThan(150);
  expect(requests).toEqual(['auth-kit-preview.js']);
  expect(navigations).toEqual([]);
  expect(errors).toEqual([]);
  expect(await exitsUsed(page)).toEqual({ touches: [], storage: [0, 0] });
});

test('typing works, and onAction carries the values and where the live card goes next', async ({ page }) => {
  await openHarness(page);
  await page.evaluate((font) => {
    (window as unknown as { log: unknown[] }).log = [];
    window.card = window.AuthKitPreview.render(document.getElementById('host')!, {
      screen: 'email',
      family: 'unc',
      font,
      onAction: (name, info) => (window as unknown as { log: unknown[] }).log.push({ name, next: info.next, values: info.values, label: info.label }),
    });
  }, FONT);
  await page.getByLabel('Email address').fill('grace@example.org');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a password instead' }).click();
  // Enter in the field submits the form, as it does live.
  await page.getByLabel('Email address').press('Enter');
  expect(await page.evaluate(() => (window as unknown as { log: unknown[] }).log)).toEqual([
    { name: 'continue', next: { screen: 'choose' }, values: { username: 'grace@example.org' }, label: 'Continue' },
    { name: 'use-password', next: { screen: 'password' }, values: { username: 'grace@example.org' }, label: 'Use a password instead' },
    { name: 'continue', next: { screen: 'choose' }, values: { username: 'grace@example.org' }, label: 'Continue' },
  ]);
  await expect(page.locator('[data-auth-kit="sign-in"]')).toHaveAttribute('data-auth-kit-view', 'email');
});

test('many cards on one page: each its own IDs, labels pair with their own fields', async ({ page }) => {
  await openHarness(page);
  const ok = await page.evaluate((font) => {
    const host = document.getElementById('host')!;
    const cards = ['email', 'password', 'totp', 'email-code'].map((screen) => window.AuthKitPreview.render(host, { screen, font }));
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    const paired = [...document.querySelectorAll('label[for]')].every((label) => label.closest('[data-backdrop-card]')!.contains(document.getElementById(label.getAttribute('for')!)));
    cards.forEach((c) => c.destroy());
    return { unique: new Set(ids).size === ids.length, paired, left: host.children.length };
  }, FONT);
  expect(ok).toEqual({ unique: true, paired: true, left: 0 });
});

test('a bad spec throws a clear error, and draws nothing', async ({ page }) => {
  await openHarness(page);
  const message = await page.evaluate(() => {
    try {
      window.AuthKitPreview.render(document.getElementById('host')!, { screen: 'nope' });
      return 'drew';
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message} (${document.getElementById('host')!.children.length} drawn)`;
    }
  });
  expect(message).toMatch(/^PreviewSpecError: auth-kit\/preview: there's no screen "nope"\. Screens: email, choose, .*\(0 drawn\)$/);
});

test('backdrops: only the styles file loads, once; still frames; no subject tour, so nothing is stored', async ({ page }) => {
  const { requests, errors } = await openHarness(page);
  const drawn = await page.evaluate(async (font) => {
    const host = document.getElementById('host')!;
    const out: Record<string, string | null> = {};
    for (const style of ['contours', 'county-survey', 'star-chart'] as const) {
      const scene = document.createElement('div');
      scene.style.cssText = 'position: relative; width: 640px;';
      host.append(scene);
      window.AuthKitPreview.render(scene, { screen: 'email', family: 'osbm', font });
      // A tour would keep its place in localStorage; the preview draws the subject of the day instead.
      const backdrop = window.AuthKitPreview.renderBackdrop(scene, { style, seed: 'k3f9x2ab', family: 'osbm', still: true, ...(style !== 'contours' && { subject: { rotation: 'tour' as const } }) });
      await backdrop.ready;
      out[style] = backdrop.error ?? (backdrop.el.hasAttribute('data-ready') ? 'ready' : 'not ready');
    }
    return out;
  }, FONT);
  expect(drawn).toEqual({ contours: 'ready', 'county-survey': 'ready', 'star-chart': 'ready' });
  expect(requests).toEqual(['auth-kit-preview.js', 'auth-kit-preview-backdrops.js']);
  expect(errors).toEqual([]);
  expect(await exitsUsed(page)).toEqual({ touches: [], storage: [0, 0] });
});

test('the harness itself notices a request, a stored value, and a navigation (so the tests above can fail)', async ({ page }) => {
  const { requests, navigations } = await openHarness(page);
  await page.evaluate(async () => {
    localStorage.setItem('x', '1');
    await fetch('https://example.org/').catch(() => undefined);
  });
  await page.evaluate(() => {
    location.hash = '#moved';
  });
  expect(await exitsUsed(page)).toEqual({ touches: ['storage.setItem', 'fetch'], storage: [1, 0] });
  expect(requests).toEqual(['auth-kit-preview.js', 'REFUSED https://example.org/']);
  expect(navigations.length).toBeGreaterThan(0);
});
