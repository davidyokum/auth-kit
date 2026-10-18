import { describe, expect, it } from 'vitest';
import { BACKDROP_FAMILIES } from '../../src/backdrops/index.js';
import {
  CARD_EDGE_CONTRAST,
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

  it('keeps the authorized-use line off by default (register A10 is Proposed), and only OSBM has one', () => {
    for (const theme of Object.values(FAMILY_THEMES)) expect(theme.showAuthorizedUse).toBe(false);
    expect(FAMILY_THEMES.osbm.authorizedUseLine).toBe('This is a State of North Carolina system for authorized use.');
    expect(FAMILY_THEMES.unc.authorizedUseLine).toBeNull();
    expect(authTheme('osbm', { showAuthorizedUse: true }).showAuthorizedUse).toBe(true);
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
  it('ships no help address, names the owner on OSBM and UNC sites, and the team on personal ones', () => {
    for (const theme of Object.values(FAMILY_THEMES)) expect(theme.help.address).toBeNull();
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
