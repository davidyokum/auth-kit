/**
 * The optional stylesheet (`authKitStyles`): the choice screen's rows as Card Studio's `.c-ways` draws
 * them (passwords-flow design/shared/sign-in-card.js), at zero specificity, with the option border from
 * the card style's variables.
 */
import { describe, expect, it } from 'vitest';
import { authKitStyles } from '../../src/client/index.js';
import { authTheme, cardStyleVariables } from '../../src/themes/index.js';

/** The declarations of the rule whose selector list is exactly `selector`, as a property → value map. */
function rule(selector: string): Record<string, string> {
  const line = authKitStyles.split('\n').find((l) => l.startsWith(`${selector} {`));
  if (!line) throw new Error(`no rule for ${selector}`);
  const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}
const at = (inner: string) => `:where([data-auth-kit] ${inner})`;

describe('"How do you want to sign in?" rows (register A5a, Card Studio .c-ways)', () => {
  it('the list is a column of rows, 10px apart, with no bullets', () => {
    expect(rule(at('[data-auth-kit-slot="ways"]'))).toMatchObject({ 'list-style': 'none', padding: '0', display: 'flex', 'flex-direction': 'column', gap: '10px' });
  });

  it('each row is full width: icon, words, chevron in a line, at least 60px tall, words aligned to the start, not centred', () => {
    expect(rule(at('[data-auth-kit-slot="way"]'))).toMatchObject({
      display: 'flex',
      'align-items': 'center',
      gap: '14px',
      width: '100%',
      'min-height': '60px',
      'text-align': 'start',
      'font-weight': '600',
      'font-size': '17px',
      border: '1px solid var(--ak-option-border, #d8dde0)',
    });
    // The chevron sits at the far end; the icons don't shrink.
    expect(rule(at('[data-auth-kit-slot="way"] > [data-auth-kit-icon="chevron"]'))).toMatchObject({ 'margin-left': 'auto' });
    expect(rule(at('[data-auth-kit-slot="way"] > svg'))).toMatchObject({ flex: 'none', width: '22px', height: '22px' });
  });

  it('one line per row (0.1.18): the label alone, no "Recommended" pill, and no row filled like a button', () => {
    expect(rule(at('[data-auth-kit-slot="wayText"]'))).toMatchObject({ display: 'flex', 'flex-direction': 'column', 'min-width': '0' });
    // The description slot keeps its rule for a site that adds one of its own.
    expect(rule(at('[data-auth-kit-slot="wayDescription"]'))).toMatchObject({ display: 'block', 'font-weight': '400', 'font-size': '16px' });
    expect(authKitStyles).not.toContain('data-auth-kit-recommended-label');
    expect(authKitStyles).not.toContain('[data-auth-kit-slot="way"][data-auth-kit-recommended]');
  });

  it('the bold passkey retry (a browser that remembers a passkey): the primary button, led by a glowing fingerprint', () => {
    expect(rule(at('[data-auth-kit-slot="button"][data-auth-kit-recommended]'))).toMatchObject({ 'justify-content': 'flex-start', 'min-height': '60px' });
    expect(rule(at('[data-auth-kit-slot="button"][data-auth-kit-recommended] > [data-auth-kit-icon="fingerprint"]'))).toMatchObject({ background: '#fff', 'border-radius': '50%', color: 'var(--ak-recommended-icon, #047857)' });
    // After the generic icon colour, so the green wins at equal (zero) specificity.
    const lines = authKitStyles.split('\n');
    const generic = lines.findIndex((l) => l.startsWith(':where([data-auth-kit] [data-auth-kit-icon="fingerprint"], '));
    const green = lines.findIndex((l) => l.startsWith(at('[data-auth-kit-slot="button"][data-auth-kit-recommended] > [data-auth-kit-icon="fingerprint"]')));
    expect(generic).toBeGreaterThanOrEqual(0);
    expect(green).toBeGreaterThan(generic);
    // The glow pulses only when motion is welcome.
    expect(authKitStyles).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{ :where\(\[data-auth-kit\] \[data-auth-kit-slot="button"\]\[data-auth-kit-recommended\] > \[data-auth-kit-icon="fingerprint"\]\) \{ animation: ak-glow/);
  });
});

describe('"Back" and the choice screen’s intro (0.1.18)', () => {
  it('Back is a quiet link-coloured button at the start of the line, not full width, at least 36px tall', () => {
    expect(rule(at('[data-auth-kit-slot="back"]'))).toMatchObject({ display: 'inline-flex', 'justify-self': 'start', 'min-height': '36px', color: 'var(--ak-link, #1668b0)', background: 'transparent', border: '0', cursor: 'pointer' });
    expect(rule(at('[data-auth-kit-slot="back"] > svg'))).toMatchObject({ flex: 'none', width: '18px', height: '18px' });
  });

  it('the intro is plain text: two short paragraphs, the address and "First time signing in?" in the ink colour, long addresses wrap', () => {
    expect(rule(at('[data-auth-kit-slot="intro"]'))).toMatchObject({ display: 'grid', gap: '8px', margin: '0' });
    expect(rule(at('[data-auth-kit-slot="intro"] p'))).toMatchObject({ margin: '0' });
    expect(rule(at('[data-auth-kit-slot="intro"] strong'))).toMatchObject({ 'font-weight': '600', color: 'var(--ak-ink, #092940)', 'overflow-wrap': 'anywhere' });
  });

  it('every new rule stays at zero specificity', () => {
    for (const line of authKitStyles.split('\n').filter((l) => /slot="(back|intro)"|slot="button"\]\[data-auth-kit-recommended/.test(l))) expect(line.replace(/^@media \([^)]*\) \{ /, '').startsWith(':where(')).toBe(true);
  });
});

describe('"How do you want to sign in?" rows, continued', () => {
  it('every rule stays at zero specificity, so a site’s own styles win', () => {
    // A rule inside a media query (the hover lift and the glow, motion permitting) is checked inside it.
    for (const line of authKitStyles.split('\n').filter((l) => /slot="way/.test(l))) expect(line.replace(/^@media \([^)]*\) \{ /, '').startsWith(':where(')).toBe(true);
  });

  it('the option border follows the card style (the studio’s --c-opt-bd): the light border on Quiet and Monogram, a hairline on the others', () => {
    const border = (style: 'quiet' | 'monogram' | 'frosted' | 'plain' | 'porcelain') => cardStyleVariables(authTheme('osbm', { cardStyle: style }))['--ak-option-border'];
    expect(border('quiet')).toBe('#d8dde0');
    expect(border('monogram')).toBe('#e2dcd2');
    for (const style of ['frosted', 'plain', 'porcelain'] as const) {
      expect(border(style)).toBe(cardStyleVariables(authTheme('osbm', { cardStyle: style }))['--ak-hair'] ?? '');
    }
  });
});
