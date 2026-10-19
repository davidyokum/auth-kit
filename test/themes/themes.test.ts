import { describe, expect, it } from 'vitest';
import { BACKDROP_FAMILIES } from '../../src/backdrops/index.js';
import {
  CARD_EDGE_CONTRAST,
  CARD_STYLES,
  FAMILY_THEMES,
  authTheme,
  cardEdgeColor,
  HELP_ADDRESS_PLACEHOLDER,
  checkCardEdge,
  definedCardEdge,
  helpAddressProblems,
  senderDisplayName,
  softCardEdge,
  themeCssVariables,
} from '../../src/themes/index.js';
import { contrastRatio } from '../../src/backdrops/kernel/v1/color.js';

describe('families as themes (E1, E2, E4, A9)', () => {
  it('carries the footer identity line, the sender, and the email hint for each family', () => {
    expect(FAMILY_THEMES.osbm.footer).toBe('This site is managed by the NC Office of State Budget and Management');
    expect(FAMILY_THEMES.unc.footer).toBe('This site is managed by UNC-Chapel Hill');
    expect(FAMILY_THEMES.personal.footer).toBeNull();
    expect(senderDisplayName('Example Reports', 'osbm')).toBe('Example Reports (NC OSBM)');
    expect(senderDisplayName('Lab Scheduler', 'unc')).toBe('Lab Scheduler (UNC)');
    expect(senderDisplayName('Example Lab', 'personal')).toBe('Example Lab');
    expect([FAMILY_THEMES.osbm.emailHint, FAMILY_THEMES.unc.emailHint, FAMILY_THEMES.personal.emailHint]).toEqual(['name@osbm.nc.gov', 'name@unc.edu', 'name@example.com']);
  });

  it('has no authorized-use line (register A10 dropped it) and refuses the old override', () => {
    for (const theme of Object.values(FAMILY_THEMES)) expect(theme).not.toHaveProperty('authorizedUseLine');
    expect(() => authTheme('osbm', { showAuthorizedUse: true } as never)).toThrow(/authorized-use line was dropped/);
  });

  it('the personal family lives on yokum.app (register F11): sign-in@ and help@', () => {
    expect(FAMILY_THEMES.personal.senderAddress).toBe('sign-in@yokum.app');
    expect(FAMILY_THEMES.personal.help.address).toBe('help@yokum.app');
    expect(FAMILY_THEMES.personal.help.domains).toEqual(['yokum.app']);
    expect([FAMILY_THEMES.osbm.senderAddress, FAMILY_THEMES.unc.senderAddress]).toEqual([null, null]);
  });

  it('defaults to the Quiet card and takes the other four styles per site (register E5)', () => {
    for (const theme of Object.values(FAMILY_THEMES)) expect(theme.cardStyle).toBe('quiet');
    for (const style of ['quiet', 'monogram', 'frosted', 'plain', 'porcelain'] as const) expect(authTheme('unc', { cardStyle: style }).cardStyle).toBe(style);
    expect(() => authTheme('unc', { cardStyle: 'glass' as never })).toThrow(/cardStyle must be one of/);
  });

  it('lets a site set its own email hint (A9), and nothing it shouldn’t', () => {
    expect(authTheme('osbm', { emailHint: 'name@nc.gov' }).emailHint).toBe('name@nc.gov');
    expect(() => authTheme('osbm', { emailHint: 'not an address' })).toThrow(/example address/);
    expect(() => authTheme('osbm', { footer: 'x' } as never)).toThrow(/can't be overridden/);
    expect(() => authTheme('osbm', { emailLetterhead: false } as never)).toThrow(/can't be overridden/);
    expect(() => authTheme('osbm', { passkeyIcon: 'fido' } as never)).toThrow(/can't be overridden/);
    expect(() => authTheme('nope' as never)).toThrow(/isn't one of/);
  });

  it('uses the families’ brand colors from auth-kit/backdrops', () => {
    for (const [family, theme] of Object.entries(FAMILY_THEMES)) {
      const card = BACKDROP_FAMILIES[family as keyof typeof BACKDROP_FAMILIES].card;
      expect(theme.colors).toMatchObject({ link: card.link, button: card.button, ink: card.heading, focus: card.focus });
    }
  });

  it('meets WCAG AA for text and controls on the card', () => {
    for (const theme of Object.values(FAMILY_THEMES)) {
      const c = theme.colors;
      for (const fg of [c.ink, c.text, c.muted, c.link, c.error]) expect(contrastRatio(fg, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.buttonText, c.button)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.focus, c.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.fieldBorder, c.surface)).toBeGreaterThanOrEqual(3);
      // Icons in the family accent (the passkey fingerprint, register E4d) are graphics: 3:1.
      expect(contrastRatio(c.accent, c.surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the help route (David, 2026-10-18; Card Studio v4)', () => {
  it('ships no help address for OSBM and UNC (personal: help@yokum.app), names the owner on OSBM and UNC sites, and the team on personal ones', () => {
    expect([FAMILY_THEMES.osbm.help.address, FAMILY_THEMES.unc.help.address]).toEqual([null, null]);
    expect([FAMILY_THEMES.osbm.help.named, FAMILY_THEMES.unc.help.named, FAMILY_THEMES.personal.help.named]).toEqual([true, true, false]);
    expect(FAMILY_THEMES.osbm.help.itDesk).toBe('your agency’s IT help desk');
    expect(FAMILY_THEMES.unc.help.itDesk).toBe('the UNC IT help desk');
    expect(FAMILY_THEMES.personal.help.itDesk).toBe('your email provider, or your IT help desk if your organization runs your email');
    expect(authTheme('osbm', { helpNamed: false }).help.named).toBe(false);
  });

  it('takes a role-based help mailbox, and refuses a missing, placeholder, or personal one', () => {
    expect(authTheme('osbm', { helpAddress: 'Apps-Help@Agency.example.org' }).help.address).toBe('apps-help@agency.example.org');
    expect(helpAddressProblems(undefined)[0]).toMatch(/needs a help address/);
    expect(helpAddressProblems(HELP_ADDRESS_PLACEHOLDER)[0]).toMatch(/placeholder/);
    for (const bad of ['help@site.test', 'todo@example.org', 'changeme@example.org', 'help@your-domain.org']) expect(helpAddressProblems(bad)[0], bad).toMatch(/placeholder/);
    expect(helpAddressProblems('jordan.lee@example.org')[0]).toMatch(/person's own address/);
    // A person's own address only with the site's acknowledgement (register E4c).
    expect(helpAddressProblems('jordan.lee@example.org', { personal: true })).toEqual([]);
    const own = authTheme('osbm', { helpAddress: { address: 'Jordan.Lee@agency.example.org', personal: true } });
    expect([own.help.address, own.help.personal]).toEqual(['jordan.lee@agency.example.org', true]);
    expect(() => authTheme('osbm', { helpAddress: 'jordan.lee@agency.example.org' })).toThrow(/personal: true/);
    expect(helpAddressProblems('not an address')[0]).toMatch(/isn't an email address/);
    expect(() => authTheme('osbm', { helpAddress: HELP_ADDRESS_PLACEHOLDER })).toThrow(/placeholder/);
  });
});

describe('the card edge (E5, ADR 0021)', () => {
  it("defaults to a defined line that reaches 3:1 against every backdrop color, by itself or with the card's surface", () => {
    for (const theme of Object.values(FAMILY_THEMES)) {
      expect(theme.cardEdge).toBe('defined');
      const check = checkCardEdge(theme);
      expect(check.required).toBe(true);
      expect(check.pass, theme.family).toBe(true);
      for (const a of check.against) expect(Math.max(a.line, a.surface)).toBeGreaterThanOrEqual(CARD_EDGE_CONTRAST);
    }
  });

  it('is the lightest such ink tint (Card Studio’s definedEdge search)', () => {
    for (const theme of Object.values(FAMILY_THEMES)) {
      const line = definedCardEdge({ palette: theme.palette, ink: theme.colors.ink });
      expect(contrastRatio(line, theme.palette.page)).toBeGreaterThanOrEqual(3.05);
      expect(contrastRatio(line, '#ffffff')).toBeLessThan(contrastRatio(theme.colors.ink, '#ffffff'));
    }
  });

  it("offers a soft hairline, which isn't required to reach 3:1", () => {
    const soft = authTheme('osbm', { cardEdge: 'soft' });
    expect(cardEdgeColor(soft)).toBe(softCardEdge({ ink: soft.colors.ink }));
    expect(checkCardEdge(soft).required).toBe(false);
    expect(() => authTheme('osbm', { cardEdge: 'bold' as 'soft' })).toThrow(/defined' or 'soft/);
  });

  it('exposes the theme as CSS custom properties, the edge included', () => {
    const vars = themeCssVariables(FAMILY_THEMES.unc);
    expect(vars['--ak-button']).toBe(FAMILY_THEMES.unc.colors.button);
    expect(vars['--ak-edge']).toBe(cardEdgeColor(FAMILY_THEMES.unc));
  });
});

describe('the help address is a plain mailbox (M8)', () => {
  it('refuses a local part that changes what a mailto: link does, or has empty parts', () => {
    for (const bad of ['help?subject=Send+your+code@site.gov', 'help#x@site.gov', 'help%41@site.gov', 'help/x@site.gov', 'help!@site.gov', 'a..b@site.gov', '.help@site.gov', 'help.@site.gov', "o'brien@site.gov"]) {
      expect(helpAddressProblems(bad)[0], bad).toMatch(/isn't a plain mailbox|isn't an email address/);
    }
  });

  it('accepts letters, digits, dots, plus, hyphen, and underscore', () => {
    for (const good of ['apps-help@osbm.nc.gov', 'it_help+reports@unc.edu', 'desk.2@example.org']) expect(helpAddressProblems(good), good).toEqual([]);
  });

  it('the families list their own domains for the Super admin override; personal lists yokum.app (register F11)', () => {
    expect(FAMILY_THEMES.osbm.help.domains).toEqual(['nc.gov']);
    expect(FAMILY_THEMES.unc.help.domains).toEqual(['unc.edu']);
    expect(FAMILY_THEMES.personal.help.domains).toEqual(['yokum.app']);
  });
});


describe('the card styles (register E5; Card Studio tokens())', () => {
  it('Quiet keeps the 12px card and defined edge; the others change only what their direction does', () => {
    const quiet = themeCssVariables(authTheme('osbm'));
    expect(quiet['--ak-card-radius']).toBe('12px');
    expect(quiet['--ak-edge']).toBe(cardEdgeColor(authTheme('osbm')));
    const porcelain = themeCssVariables(authTheme('osbm', { cardStyle: 'porcelain' }));
    expect(porcelain['--ak-card-radius']).toBe('20px');
    expect(porcelain['--ak-button-bg']).toBe('linear-gradient(180deg, #1e79c8, #196ab1)');
    const frosted = themeCssVariables(authTheme('unc', { cardStyle: 'frosted' }));
    expect(frosted['--ak-card-bg']).toBe('rgba(255,255,255,0.66)');
    expect(frosted['--ak-card-solid']).toMatch(/^#[0-9a-f]{6}$/);
    const plain = authTheme('personal', { cardStyle: 'plain' });
    expect(themeCssVariables(plain)['--ak-edge']).toBe('transparent');
    expect(checkCardEdge(plain)).toMatchObject({ required: false, pass: true });
    expect(themeCssVariables(authTheme('unc', { cardStyle: 'monogram' }))['--ak-mono']).toBe('#4b9cd3');
  });

  it('every radius is a length, never a bare 0 (calc() refuses it: Plain’s choice rows lost their 10px corners)', () => {
    for (const cardStyle of CARD_STYLES) {
      const v = themeCssVariables(authTheme('osbm', { cardStyle }));
      for (const key of ['--ak-card-radius', '--ak-control-radius'] as const) expect(v[key], `${cardStyle} ${key}`).toMatch(/^\d+(\.\d+)?px$/);
    }
  });
});
