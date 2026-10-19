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

  it('the words stack: the label (with "(recommended)" in regular weight), then the description on its own line', () => {
    expect(rule(at('[data-auth-kit-slot="wayText"]'))).toMatchObject({ display: 'flex', 'flex-direction': 'column', 'min-width': '0' });
    expect(rule(at('[data-auth-kit-slot="wayDescription"]'))).toMatchObject({ display: 'block', 'font-weight': '400', 'font-size': '16px' });
    expect(rule(at('[data-auth-kit-slot="wayLabel"] [data-auth-kit-recommended-label]'))).toMatchObject({ 'font-weight': '400' });
  });

  it('the recommended row is tinted with no border, like the studio’s .rec', () => {
    expect(rule(at('[data-auth-kit-slot="way"][data-auth-kit-recommended]'))).toMatchObject({ background: 'var(--ak-status, rgba(9, 41, 64, 0.045))', 'border-color': 'transparent' });
  });

  it('every rule stays at zero specificity, so a site’s own styles win', () => {
    for (const line of authKitStyles.split('\n').filter((l) => /slot="way/.test(l))) expect(line.startsWith(':where(')).toBe(true);
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
