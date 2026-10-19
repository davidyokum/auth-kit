/**
 * The whole matrix, in a real browser, from the standalone file: every screen and state × every family ×
 * every card style × a light and a dark page × desktop and phone (3,120 cards).
 *
 * - Checks that hold for every card: each control is styled (the card's font, no browser-default button
 *   face or bevel; the unstyled choice-screen buttons of v0.1.9-alpha.1 fail here), big controls are at
 *   least 44px tall, nothing overflows the card sideways, the card is its device's width, a heading shows,
 *   every slot is a known one, and nothing left the page.
 * - Computed contrast on every card (`contrast.ts`): text 4.5:1, the focus ring and boundaries 3:1, each
 *   measured from the rendered colours over what's really behind it. On a failure the list names each look,
 *   what failed, the colours, the ratio, and how many cards share it.
 * - Button words (`words.ts`, register A6): no step another step follows says "Create account", "Finish", or
 *   "Sign in" on its primary button; checked on every card here, and in every account-creation mode below.
 * - A computed-style baseline per family (`__snapshots__/matrix.spec.ts/styles-<family>.json`): every
 *   slot's computed style on the base look (Quiet, light page, desktop), and for each other look only what
 *   differs. Any change in how the card is styled shows up here as a reviewable diff.
 *
 * Each family's lowest ratios, per look and kind, are written to `contrast-<family>.json` in the test's output
 * folder (`test-results/`), for the record.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT_CREATION_MODES } from '../../src/shared/account-creation.js';
import { PREVIEW_SCREENS } from '../../src/preview/screens.js';
import { installContrastProbe } from './contrast.js';
import { exitsUsed, FONT, openHarness } from './harness.js';
import { FINAL_WORDS, installWordsProbe } from './words.js';

const FAMILIES = ['osbm', 'unc', 'personal'] as const;
const STATES = PREVIEW_SCREENS.flatMap((s) => s.states.map((st) => [s.id, st.id] as [string, string]));
/** Every slot the card's markup may carry (`AuthKitSlot`). */
const SLOTS = [
  'root', 'heading', 'text', 'form', 'field', 'label', 'input', 'hint', 'error', 'status', 'actions', 'button', 'secondaryButton', 'linkButton', 'section', 'list',
  'listItem', 'code', 'link', 'content', 'card', 'bottom', 'below', 'summary', 'fieldError', 'note', 'wait', 'alts', 'who', 'contact', 'steps', 'access', 'footer',
  'choice', 'small', 'showButton', 'glyph', 'inputWrap', 'monogram', 'ways', 'way', 'wayText', 'wayLabel', 'wayDescription',
];

interface MatrixArgs {
  family: string;
  cardStyles: readonly string[];
  states: [string, string][];
  font: string;
  slots: string[];
  finalWords: readonly string[];
}

/** The probes the matrix calls in the page, and the keyboard as the last thing used, so focus shows its ring. */
async function prepare(page: Page): Promise<void> {
  await page.evaluate(installContrastProbe);
  await page.evaluate(installWordsProbe);
  await page.keyboard.press('Shift');
}

/** Runs in the page: draws every card of one family and checks it. */
function runMatrix(arg: MatrixArgs) {
  const P = window.AuthKitPreview;
  const host = document.getElementById('host')!;
  const violations: string[] = [];
  const words: string[] = [];
  /** Contrast failures, grouped: one line per look, kind, slot, and colours, with how many cards share it. */
  const failures = new Map<string, { n: number; first: string }>();
  /** The lowest ratio of each kind, per look (`style/theme`), and where. */
  const lows: Record<string, Record<string, { ratio: number; fg: string; bg: string; where: string }>> = {};
  const effects: string[] = [];
  let actions = 0;
  const PROPS = [
    'display', 'color', 'background-color', 'background-image', 'border-top-width', 'border-top-style', 'border-top-color', 'border-bottom-width', 'border-bottom-style',
    'border-bottom-color', 'border-top-left-radius', 'box-shadow', 'backdrop-filter', 'font-size', 'font-weight', 'line-height', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'min-height', 'gap', 'text-decoration-line', 'opacity', 'cursor',
  ];
  const CONTEXTS = ['alts', 'bottom', 'actions', 'who', 'summary', 'contact', 'ways', 'list', 'field', 'text', 'note', 'steps', 'choice', 'below', 'access', 'small', 'wait'];
  // Chromium's own button faces (light and dark color schemes): a control showing one has no styles.
  const BROWSER_FACE = new Set(['rgb(239, 239, 239)', 'rgb(240, 240, 240)', 'rgb(107, 107, 107)', 'rgb(59, 59, 59)']);
  const looks: Record<string, Record<string, string>> = {};
  const card = P.render(host, { screen: 'email', family: arg.family as 'osbm', font: arg.font });

  for (const cardStyle of arg.cardStyles) {
    for (const theme of ['light', 'dark'] as const) {
      for (const device of ['desktop', 'phone'] as const) {
        const look = `${cardStyle}/${theme}/${device}`;
        const styles: Record<string, string> = {};
        const record = (key: string, el: Element, extra: string[] = []) => {
          const cs = getComputedStyle(el);
          const value = [...PROPS, ...extra].map((p) => `${p}: ${cs.getPropertyValue(p)}`).join('; ');
          let k = key;
          for (let i = 2; k in styles && styles[k] !== value; i++) k = `${key} #${i}`;
          styles[k] = value;
        };
        for (const [screen, state] of arg.states) {
          card.update({
            screen,
            state,
            family: arg.family as 'osbm',
            cardStyle: cardStyle as 'quiet',
            theme,
            device,
            font: arg.font,
            ground: true,
            ...(screen === 'request-access' && { accountCreation: 'request' as const }),
            onAction: () => {
              actions++;
            },
            onEffect: (name: string) => effects.push(name),
          });
          const where = `${look} ${screen}/${state}`;
          const stage = card.el;
          const box = card.card;
          for (const f of window.__akContrast.measure(stage)) {
            const key = `${cardStyle}/${theme}`;
            const low = (lows[key] ??= {});
            if (!low[f.kind] || f.ratio < low[f.kind]!.ratio) low[f.kind] = { ratio: f.ratio, fg: f.fg, bg: f.bg, where: `${device} ${screen}/${state} ${f.what}` };
            if (f.info || f.ratio >= f.minimum) continue;
            const slot = f.what.slice(0, f.what.indexOf(' ') === -1 ? undefined : f.what.indexOf(' '));
            const line = `${look} ${f.kind} (${slot}): ${f.fg || '?'} on ${f.bg || '?'}, ${f.ratio.toFixed(3)}:1, under ${f.minimum}:1`;
            const seen = failures.get(line);
            if (seen) seen.n++;
            else failures.set(line, { n: 1, first: `${screen}/${state} ${f.what}` });
          }
          for (const problem of window.__akWords.check(stage, card.actions(), arg.finalWords)) words.push(`${where}: ${problem}`);
          const cardFont = getComputedStyle(box).fontFamily;
          const heading = stage.querySelector('[data-auth-kit-slot="heading"]');
          if (!heading?.textContent?.trim() || heading.getBoundingClientRect().height === 0) violations.push(`${where}: no visible heading`);
          const width = box.getBoundingClientRect().width;
          const expected = P.widths[device];
          if (Math.abs(width - expected) > 0.5) violations.push(`${where}: the card is ${width}px wide, not ${expected}px`);
          if (box.scrollWidth > box.clientWidth + 1) violations.push(`${where}: something overflows the card sideways (${box.scrollWidth}px in ${box.clientWidth}px)`);
          // The Plain style's stage clips its column (overflow: hidden); anything else must fit.
          if (getComputedStyle(stage).overflowX === 'visible' && stage.scrollWidth > stage.clientWidth + 1) violations.push(`${where}: something overflows the stage sideways`);
          for (const el of stage.querySelectorAll('[data-auth-kit-slot]')) {
            const slot = el.getAttribute('data-auth-kit-slot')!;
            if (!arg.slots.includes(slot)) violations.push(`${where}: unknown slot "${slot}"`);
          }
          for (const el of box.querySelectorAll<HTMLElement>('button, input, textarea, a')) {
            if (el.hidden || (el instanceof HTMLInputElement && el.type === 'hidden')) continue;
            const cs = getComputedStyle(el);
            const slot = el.getAttribute('data-auth-kit-slot') ?? el.tagName.toLowerCase();
            const what = `${where} ${slot} "${(el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 32)}"`;
            if (cs.fontFamily !== cardFont) violations.push(`${what}: font "${cs.fontFamily}", not the card's "${cardFont}" (unstyled)`);
            if (parseFloat(cs.fontSize) < 14) violations.push(`${what}: ${cs.fontSize} text`);
            if (el.tagName !== 'A') {
              if (BROWSER_FACE.has(cs.backgroundColor)) violations.push(`${what}: the browser's default face ${cs.backgroundColor} (unstyled)`);
              if (cs.borderTopStyle === 'outset' || cs.borderTopStyle === 'inset') violations.push(`${what}: the browser's default ${cs.borderTopStyle} border (unstyled)`);
            }
            const big = ['button', 'secondaryButton', 'way', 'input'].includes(slot) || (slot === 'linkButton' && el.closest('[data-auth-kit-slot="alts"]'));
            const height = el.getBoundingClientRect().height;
            if (big && height < 44) violations.push(`${what}: ${height}px tall, under 44px`);
          }
          // color-scheme is inherited: recorded once, on the stage (the page), not on every element.
          record('stage', stage, ['color-scheme']);
          for (const el of stage.querySelectorAll('[data-auth-kit-slot]')) {
            const slot = el.getAttribute('data-auth-kit-slot')!;
            let context = 'card';
            for (let p = el.parentElement; p && p !== stage; p = p.parentElement) {
              const s = p.getAttribute('data-auth-kit-slot');
              if (s && CONTEXTS.includes(s)) {
                context = s;
                break;
              }
            }
            const variant = [
              el.hasAttribute('data-auth-kit-recommended') ? '[recommended]' : '',
              el.getAttribute('aria-invalid') === 'true' ? '[invalid]' : '',
              el.hasAttribute('data-danger') ? '[danger]' : '',
              (el as HTMLButtonElement).disabled ? '[disabled]' : '',
              el.tagName === 'TEXTAREA' || el.tagName === 'A' ? `(${el.tagName.toLowerCase()})` : '',
            ].join('');
            record(`${context} > ${slot}${variant}`, el, slot === 'card' ? ['width'] : []);
          }
        }
        looks[look] = styles;
      }
    }
  }
  card.destroy();

  // The base look in full; every other look as the properties that differ from it.
  const base = looks['quiet/light/desktop']!;
  const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const props = (value: string) => new Map(value.split('; ').map((pair) => [pair.slice(0, pair.indexOf(':')), pair] as const));
  const differences: Record<string, Record<string, string>> = {};
  for (const [look, styles] of Object.entries(looks)) {
    if (look === 'quiet/light/desktop') continue;
    const diff: Record<string, string> = {};
    for (const [key, value] of Object.entries(styles)) {
      if (base[key] === value) continue;
      if (base[key] === undefined) {
        diff[key] = value;
        continue;
      }
      const was = props(base[key]);
      diff[key] = [...props(value).entries()].filter(([p, pair]) => was.get(p) !== pair).map(([, pair]) => pair).join('; ');
    }
    for (const key of Object.keys(base)) if (!(key in styles)) diff[key] = '(absent)';
    differences[look] = sorted(diff);
  }
  const contrast = [...failures].map(([line, { n, first }]) => `${line} (${n} card${n === 1 ? '' : 's'}, e.g. ${first})`).sort();
  return { violations, contrast, words, lows, effects, actions, cards: Object.keys(looks).length * arg.states.length, styles: { base: sorted(base), differences } };
}

for (const family of FAMILIES) {
  test(`every screen, state, card style, page theme, and device: ${family}`, async ({ page }, testInfo) => {
    const { requests, navigations, errors } = await openHarness(page);
    await prepare(page);
    const result = await page.evaluate(runMatrix, { family, cardStyles: ['quiet', 'monogram', 'frosted', 'plain', 'porcelain'], states: STATES, font: FONT, slots: SLOTS, finalWords: FINAL_WORDS });
    writeFileSync(testInfo.outputPath(`contrast-${family}.json`), `${JSON.stringify(result.lows, null, 1)}\n`);
    expect(result.cards).toBe(5 * 2 * 2 * STATES.length);
    // Soft, so one run lists every kind of problem.
    expect.soft(result.violations).toEqual([]);
    expect.soft(result.contrast).toEqual([]);
    expect.soft(result.words).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result.actions).toBe(0);
    expect(`${JSON.stringify(result.styles, null, 1)}\n`).toMatchSnapshot(`styles-${family}.json`);
    // Nothing left the page.
    expect(requests).toEqual(['auth-kit-preview.js']);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
    expect(await exitsUsed(page)).toEqual({ touches: [], storage: [0, 0] });
  });
}

test('button words follow register A6 in every account-creation mode', async ({ page }) => {
  const { errors } = await openHarness(page);
  await prepare(page);
  const result = await page.evaluate(
    ({ states, modes, font, finalWords }) => {
      const card = window.AuthKitPreview.render(document.getElementById('host')!, { screen: 'email', font });
      const problems: string[] = [];
      let buttons = 0;
      for (const mode of modes) {
        for (const [screen, state] of states) {
          card.update({ screen, state, family: 'osbm', accountCreation: mode, font });
          buttons += card.el.querySelectorAll('[data-auth-kit-slot="button"]').length;
          for (const problem of window.__akWords.check(card.el, card.actions(), finalWords)) problems.push(`${mode} ${screen}/${state}: ${problem}`);
        }
      }
      card.destroy();
      return { problems, buttons };
    },
    { states: STATES, modes: [...ACCOUNT_CREATION_MODES], font: FONT, finalWords: FINAL_WORDS },
  );
  expect(result.buttons).toBeGreaterThan(4 * 40);
  expect(result.problems).toEqual([]);
  expect(errors).toEqual([]);
});
