import { describe, expect, it } from 'vitest';
import {
  type EmailSite,
  type RenderedEmail,
  accessRequestDigestEmail,
  accountDeletedEmail,
  clockDateTime,
  confirmNewEmailEmail,
  emailChangedEmail,
  existingAccountEmail,
  inviteEmail,
  maskEmail,
  passwordResetEmail,
  requestDeclinedEmail,
  signInCodeEmail,
  signUpCodeEmail,
} from '../../src/shared/emails.js';

const OSBM: EmailSite = { siteName: 'Example Reports', theme: 'osbm', signInUrl: 'https://reports.example.org/sign-in', helpEmail: 'help@example.org' };
const PERSONAL: EmailSite = { siteName: 'Example Lab', theme: 'personal', signInUrl: 'https://lab.example.org/sign-in', helpEmail: 'help@example.org' };
const AT = new Date('2026-10-23T21:00:00.000Z');

const CODE = '48213907';
const codeEmails = (site: EmailSite): [string, RenderedEmail][] => [
  ['sign-in', signInCodeEmail(site, { code: CODE, codeLifetimeMinutes: 3 })],
  ['sign-up', signUpCodeEmail(site, { code: CODE, codeLifetimeMinutes: 3 })],
  ['reset', passwordResetEmail(site, { code: CODE })],
  ['confirm new address', confirmNewEmailEmail(site, { code: CODE })],
];
const appEmails = (site: EmailSite): [string, RenderedEmail][] => [
  ['invite', inviteEmail(site, { email: 'sam@example.org', expiresAt: AT, invitedBy: { name: 'Jordan Lee', email: 'jordan@example.org' }, roleLabel: 'Member' })],
  ['exists (sign-up)', existingAccountEmail(site, { email: 'sam@example.org', via: 'sign-up' })],
  ['exists (request)', existingAccountEmail(site, { email: 'sam@example.org', via: 'request' })],
  ['declined', requestDeclinedEmail(site, { requestedAt: AT })],
  ['digest', accessRequestDigestEmail(site, { requests: [{ name: 'Sam', email: 'sam@example.org', reason: 'Budget work', requestedAt: AT, expiresAt: AT }], peopleUrl: 'https://reports.example.org/admin/people' })],
  ['email changed', emailChangedEmail(site, { newEmail: 'new@example.org', at: AT })],
  ['deleted', accountDeletedEmail(site, { email: 'sam@example.org', at: AT, comeBack: 'sign-up' })],
];

describe('every auth email (REPORT §5.1)', () => {
  it.each([...codeEmails(OSBM), ...appEmails(OSBM)])('%s: multipart, the same words in both parts, a written preheader, lang="en", presentational tables', (_name, email) => {
    expect(email.text.length).toBeGreaterThan(40);
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('role="presentation"');
    expect(email.html).toContain('name="color-scheme"');
    expect(email.preheader).toBeTruthy();
    expect(email.html).toContain(email.preheader!.replace(/’/g, '’'));
    expect(email.subject.length).toBeLessThanOrEqual(60);
  });

  it.each(codeEmails(OSBM))('%s: no code in the subject or preheader, the code first in monospace, and the phishing-safe line', (_name, email) => {
    expect(email.subject).not.toContain(CODE);
    expect(email.preheader).not.toContain(CODE);
    expect(email.html).toMatch(/monospace[^>]*>48213907</);
    expect(email.text).toContain('Only enter codes at reports.example.org. Example Reports will never ask you for a password or code by phone, email, or text.');
    expect(email.html).not.toMatch(/<a /);
  });

  it('match the card: no letterhead; the footer is the card’s identity sentence, then the help line (David, 2026-10-18; Card Studio v4)', () => {
    for (const [name, email] of [...codeEmails(OSBM), ...appEmails(OSBM)]) {
      expect(email.text.endsWith('\nThis site is managed by the NC Office of State Budget and Management. Help: help@example.org.'), name).toBe(true);
      expect(email.text, name).not.toMatch(/^NC Office of State Budget and Management$/m);
      expect(email.html, name).toContain('This site is managed by the NC Office of State Budget and Management. Help: help@example.org.');
    }
    const unc = signInCodeEmail({ ...OSBM, theme: 'unc' }, { code: CODE, codeLifetimeMinutes: 3 });
    expect(unc.text.endsWith('\nThis site is managed by UNC-Chapel Hill. Help: help@example.org.')).toBe(true);
  });

  it('name nobody on personal sites: the footer is the help line alone', () => {
    for (const [name, email] of [...codeEmails(PERSONAL), ...appEmails(PERSONAL)]) {
      expect(email.text.endsWith('\nHelp: help@example.org.'), name).toBe(true);
      expect(email.text, name).not.toMatch(/managed by|Yokum/);
    }
  });
});

describe('the words (Card Studio mailHTML; REPORT §5.2)', () => {
  it('the invite names the inviter, the role, the steps, and the expiry as a clock time', () => {
    const email = inviteEmail(OSBM, { email: 'sam@example.org', expiresAt: AT, invitedBy: { name: 'Jordan Lee', email: 'jordan@example.org' }, roleLabel: 'Member' });
    expect(email.subject).toBe('Jordan Lee invited you to Example Reports');
    expect(email.preheader).toBe('Accept by Friday, October 23. No password needed.');
    expect(email.text).toContain('Jordan Lee gave you access to Example Reports. Your role: Member.');
    expect(email.text).toContain('1. Go to https://reports.example.org/sign-in');
    expect(email.text).toContain('2. Enter this email address: sam@example.org');
    expect(email.text).toContain('3. Choose Email me a code instead. We’ll email you an 8-digit code. Enter it, then set up a passkey so signing in next time takes a second.');
    expect(email.text).toContain('This invitation expires on Friday, October 23 at 5:00 PM Eastern.');
    expect(email.text).toContain('Example Reports will never ask for a password or code by phone, email, or text.');
    expect(email.replyTo).toEqual(['jordan@example.org']);
  });

  it('the approved request is the invite with the approver (§5.2j)', () => {
    const email = inviteEmail(OSBM, { email: 'sam@example.org', expiresAt: AT, invitedBy: { name: 'Jordan Lee' }, roleLabel: 'Member', approved: true });
    expect(email.subject).toBe('Jordan Lee approved your request for Example Reports');
    expect(email.text).toContain('Jordan Lee approved your request and gave you access as Member.');
  });

  it('the sign-up code says no account exists until it’s used', () => {
    const email = signUpCodeEmail(OSBM, { code: '{####}', codeLifetimeMinutes: 10 });
    expect(email.subject).toBe('Your Example Reports code');
    expect(email.preheader).toBe('It works for 10 minutes. Only enter it at reports.example.org.');
    expect(email.text).toContain('Your code to create an account');
    expect(email.text).toContain('No account is created until you use this code.');
    expect(email.html).toContain('{####}');
  });

  it('the existing-account email says nothing was made and how to sign in', () => {
    const email = existingAccountEmail(OSBM, { email: 'sam@example.org', via: 'sign-up' });
    expect(email.subject).toBe('You already have an Example Reports account');
    expect(email.text).toContain('Someone, probably you, tried to create an Example Reports account with this address.');
    expect(email.text).toContain('To get in, go to https://reports.example.org/sign-in and sign in with sam@example.org.');
  });

  it('the digest lists every request and warns not to follow what they say', () => {
    const email = accessRequestDigestEmail(OSBM, {
      requests: [
        { name: 'Sam', email: 'sam@example.org', requestedAt: AT, expiresAt: new Date('2026-11-22T12:00:00Z') },
        { email: 'pat@example.org', reason: 'Budget review', requestedAt: AT, expiresAt: new Date('2026-11-20T12:00:00Z') },
      ],
      peopleUrl: 'https://reports.example.org/admin/people',
    });
    expect(email.subject).toBe('2 people asked for access to Example Reports');
    expect(email.preheader).toBe('Approve or decline on the People page by Friday, November 20.');
    expect(email.text).toContain('What it’s for, in their words: “Budget review”');
    expect(email.text).toContain('hasn’t checked what the requests say');
  });

  it('the email-changed notice masks the new address', () => {
    expect(maskEmail('new@example.org')).toBe('n•••@example.org');
    expect(emailChangedEmail(OSBM, { newEmail: 'new@example.org', at: AT }).text).toContain('changed from this one to n•••@example.org on Friday, October 23 at 5:00 PM Eastern. You made the change.');
  });

  it('formats clock times in Eastern by default', () => {
    expect(clockDateTime(AT)).toBe('Friday, October 23 at 5:00 PM Eastern');
  });
});
