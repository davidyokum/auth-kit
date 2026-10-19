/**
 * The approved words (Card Studio v4, REPORT §4–§5; ADR 0024): every user-facing string in
 * `src/client/copy.ts`, `src/client/messages.ts`, and `src/shared/emails.ts`, rendered with sample
 * values, the help screens for each family, and the access lines. The key strings are pinned exactly;
 * and a house-style lint fails on a series without the Oxford comma (register P8), over the rendered
 * words and over every string literal and JSX text in `src/client`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as copy from '../../src/client/copy.js';
import { type AuthErrorContext, describeAuthError } from '../../src/client/messages.js';
import { domainsInWords, listInWords, notOnListMessage } from '../../src/shared/account-creation.js';
import * as emails from '../../src/shared/emails.js';
import { type ThemeFamily, THEME_FAMILIES, authTheme } from '../../src/themes/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SITE = 'Example Reports';
const EMAIL = 'ada@example.org';
const HELP = 'apps-help@example.org';
const OWNER = 'Jordan Lee';

function context(family: ThemeFamily, extra: Partial<copy.CopyContext> = {}): copy.CopyContext {
  return { siteName: SITE, theme: authTheme(family), codeLifetimeMinutes: 3, helpAddress: HELP, ownerName: OWNER, ...extra };
}

/** Every context the words are rendered in: each family, with and without an owner, at 3 and 10 minutes. */
const CONTEXTS: copy.CopyContext[] = THEME_FAMILIES.flatMap((family) => [
  context(family),
  context(family, { codeLifetimeMinutes: 10 }),
  { siteName: SITE, theme: authTheme(family), codeLifetimeMinutes: 3, helpAddress: HELP },
]);

// ---- Rendering every string -------------------------------------------------------------------

/** Every group of words the deck exports (SIGN_IN, ERRORS, MY_ACCOUNT, …): a new group is linted without a change here. */
const GROUPS: Record<string, Record<string, unknown>> = Object.fromEntries(
  (Object.entries(copy) as [string, unknown][]).filter((entry): entry is [string, Record<string, unknown>] => /^[A-Z][A-Z_]+$/.test(entry[0]) && typeof entry[1] === 'object' && entry[1] !== null),
);

/**
 * Sample arguments for every function in the copy groups (a list of argument lists per context). A
 * new function without an entry fails "every copy function is rendered", so new words get linted.
 */
const CALLS: Record<string, (c: copy.CopyContext) => unknown[][]> = {
  'SIGN_IN.heading': (c) => [[c]],
  'SIGN_IN.totpSub': (c) => [[c]],
  'SIGN_IN.codeSub': (c) => [[c, EMAIL]],
  'SIGN_IN.codeResent': () => [['2:05 PM']],
  'SIGN_IN.resetCodeSub': () => [[EMAIL]],
  'SIGN_IN.checkFailed': (c) => [[c]],
  'ACCESS_LINE.inviteOnly': (c) => [[c]],
  'FIRST_VISIT.donePasskey': (c) => [[c]],
  'FIRST_VISIT.continueTo': (c) => [[c]],
  'ACCESS_HELP.heading': (c) => [[c]],
  'ACCESS_HELP.sub': (c) => [[c]],
  'ACCESS_HELP.alreadyInvited': (c) => [[c]],
  'SIGN_UP.domainHint': () => [[domainsInWords(['example.org'])], [domainsInWords(['example.org', 'edu'])], [domainsInWords(['example.org', 'example.net', 'edu'])]],
  'SIGN_UP.privacyDomains': (c) => [[c]],
  'SIGN_UP.termsOpen': (c) => [[c]],
  'SIGN_UP.codeSub': (c) => [[c, EMAIL]],
  'SIGN_UP.nameSub': (c) => [[c]],
  'SIGN_UP.doneSub': (c) => [[c]],
  'REQUEST.heading': (c) => [[c]],
  'REQUEST.sub': (c) => [[c]],
  'SELF_SERVICE.deleteConfirmHeading': (c) => [[c], [{}]],
  'SIGNED_OUT.sub': (c) => [[c]],
  'ERRORS.badEmail': (c) => [[c.theme.emailHint]],
  'ERRORS.wrongEmailCode': (c) => [[c]],
  'ERRORS.sessionExpired': (c) => [[c]],
  'ERRORS.network': (c) => [[c], [undefined]],
  'CONTACT.looksAfter': (c) => [[c]],
  'MY_ACCOUNT.couldntLoad': () => [['Too many attempts. Wait a minute, then try again.']],
  'MY_ACCOUNT.removeLabel': () => [['iPhone passkey']],
  'MY_ACCOUNT.removeQuestion': () => [['iPhone passkey']],
  'MY_ACCOUNT.removeConfirm': () => [['iPhone passkey']],
  'MY_ACCOUNT.gateCheckFailed': () => [['Check your connection and try again.']],
  'MY_ACCOUNT.gateIntro': (c) => [[c.siteName]],
  'MY_ACCOUNT.newPasswordHint': () => [[15]],
  'MY_ACCOUNT.added': () => [['Oct 18, 2026']],
};

interface Text {
  where: string;
  text: string;
}

/** A rendered value: a string, or the parts of one sentence (a tuple), joined. */
function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const parts = value.flatMap(flatten);
    return value.every((v) => typeof v === 'string') ? [parts.join('')] : parts;
  }
  if (value !== null && typeof value === 'object' && 'strong' in value) return [String((value as { strong: string }).strong)];
  return [];
}

function functionPaths(): string[] {
  return Object.entries(GROUPS).flatMap(([group, words]) => Object.entries(words).filter(([, v]) => typeof v === 'function').map(([key]) => `${group}.${key}`));
}

function copyTexts(): Text[] {
  const out: Text[] = [];
  for (const [group, words] of Object.entries(GROUPS)) {
    for (const [key, value] of Object.entries(words)) {
      const where = `${group}.${key}`;
      if (typeof value === 'function') {
        const call = CALLS[where];
        if (!call) continue; // "every copy function is rendered" reports it
        for (const c of CONTEXTS) {
          for (const args of call(c)) for (const text of flatten((value as (...a: unknown[]) => unknown)(...args))) out.push({ where, text });
        }
      } else {
        for (const text of flatten(value)) out.push({ where, text });
      }
    }
  }
  const topics = copy.TROUBLE.rows.map(([topic]) => topic);
  for (const c of CONTEXTS) {
    for (const topic of topics) {
      for (const securityNotices of [false, true]) {
        const screen = copy.helpScreen(topic, c, { securityNotices });
        const where = `helpScreen(${topic}, ${c.theme.family}${c.ownerName ? '' : ', no owner'})`;
        for (const text of [screen.heading, screen.intro, screen.after, screen.button?.label, ...(screen.steps ?? []).map(copy.plain)]) {
          if (text !== undefined) out.push({ where, text });
        }
      }
    }
    for (const teams of [false, true]) {
      const contact = copy.contactLines(c, { teams });
      out.push(...[contact.lead, ...contact.lines].map((text) => ({ where: `contactLines(${c.theme.family})`, text })));
    }
    // The access lines as the card composes them (SignIn's accessLine).
    out.push(
      { where: 'access line (invite, sentence)', text: `${copy.ACCESS_LINE.inviteOnly(c)} ${copy.ACCESS_LINE.askToBeAdded}` },
      { where: 'access line (invite, link)', text: `${copy.ACCESS_LINE.inviteOnly(c)} ${copy.ACCESS_LINE.needAccess}` },
      { where: 'access line (domains, open)', text: `${copy.ACCESS_LINE.newHere} ${copy.ACCESS_LINE.createAccount}` },
    );
  }
  for (const family of THEME_FAMILIES) {
    const theme = authTheme(family);
    for (const text of [theme.footer, theme.help.verify, theme.help.itDesk, theme.help.devDesk]) if (text) out.push({ where: `theme(${family})`, text });
  }
  for (const [domains, requestsAlso] of [[['example.org'], false], [['example.org', 'edu'], true], [['example.org', 'example.net', 'edu'], true]] as const) {
    out.push({ where: 'notOnListMessage', text: notOnListMessage(SITE, domains, requestsAlso) });
  }
  return out;
}

const CONTEXTS_FOR_ERRORS = [
  'sign-in',
  'code',
  'totp',
  'change-password',
  'set-password',
  'reset-password',
  'passkey-register',
  'passkey-remove',
  'authenticator-setup',
  'account',
] as const satisfies readonly AuthErrorContext[];
// Every context: a new one fails to compile until it's listed.
const everyContext: [Exclude<AuthErrorContext, (typeof CONTEXTS_FOR_ERRORS)[number]>] extends [never] ? true : never = true;

/** Every message `describeAuthError` can give: each error name it knows (read from the file), in each context, with and without words. */
function messageTexts(): Text[] {
  void everyContext;
  const source = readFileSync(join(ROOT, 'src/client/messages.ts'), 'utf8');
  const names = [...new Set([...source.matchAll(/case '(\w+)':/g)].map((m) => m[1]!))];
  expect(names.length).toBeGreaterThan(30);
  const details = ['', 'Invalid session for the user, session is expired.', 'Password attempts exceeded', 'Password is compromised', 'Incorrect username or password.'];
  const thrown: unknown[] = [...names.flatMap((name) => details.map((message) => Object.assign(new Error(message), { name }))), new TypeError('Failed to fetch'), 'weird'];
  const out = new Map<string, string>();
  for (const error of thrown) {
    for (const context of CONTEXTS_FOR_ERRORS) {
      for (const words of [{}, { siteName: SITE, codeLifetimeMinutes: 10, helpAddress: HELP }]) {
        const info = describeAuthError(error, context, words);
        out.set(info.message, `describeAuthError(${info.name}, ${context})`);
      }
    }
  }
  return [...out].map(([text, where]) => ({ where, text }));
}

/** Every email, rendered for each family: subject, preheader, and text (the HTML carries the same words). */
function emailTexts(): { texts: Text[]; rendered: Set<string> } {
  const at = new Date('2026-10-23T21:00:00Z');
  const rendered = new Set<string>();
  const texts: Text[] = [];
  for (const family of THEME_FAMILIES) {
    const site: emails.EmailSite = { siteName: SITE, theme: authTheme(family), signInUrl: 'https://reports.example.org/sign-in', helpEmail: HELP };
    const all: [string, emails.RenderedEmail][] = [
      ['signInCodeEmail', emails.signInCodeEmail(site, { code: '12345678', codeLifetimeMinutes: 3 })],
      ['signUpCodeEmail', emails.signUpCodeEmail(site, { code: '12345678', codeLifetimeMinutes: 10 })],
      ['passwordResetEmail', emails.passwordResetEmail(site, { code: '123456' })],
      ['confirmNewEmailEmail', emails.confirmNewEmailEmail(site, { code: '123456' })],
      ['inviteEmail', emails.inviteEmail(site, { email: EMAIL, expiresAt: at })],
      ['inviteEmail', emails.inviteEmail(site, { email: EMAIL, expiresAt: at, invitedBy: { name: OWNER, email: 'jordan@example.org' }, roleLabel: 'Admin – view only' })],
      ['inviteEmail', emails.inviteEmail(site, { email: EMAIL, expiresAt: at, invitedBy: { email: 'jordan@example.org' }, item: { noun: 'project', name: 'Roads 2027', roleLabel: 'Editor' } })],
      ['inviteEmail', emails.inviteEmail(site, { email: EMAIL, expiresAt: at, invitedBy: { name: OWNER }, approved: true })],
      ['existingAccountEmail', emails.existingAccountEmail(site, { email: EMAIL, via: 'sign-up' })],
      ['existingAccountEmail', emails.existingAccountEmail(site, { email: EMAIL, via: 'request' })],
      ['requestDeclinedEmail', emails.requestDeclinedEmail(site, { requestedAt: at })],
      ['requestDeclinedEmail', emails.requestDeclinedEmail(site, { requestedAt: at, note: 'We only add people from our office.' })],
      ['accessRequestDigestEmail', emails.accessRequestDigestEmail(site, { requests: [{ name: 'Ada Lovelace', email: EMAIL, reason: 'Quarterly reports', requestedAt: at, expiresAt: at }], peopleUrl: 'https://reports.example.org/people' })],
      [
        'accessRequestDigestEmail',
        emails.accessRequestDigestEmail(site, {
          requests: [
            { email: EMAIL, requestedAt: at, expiresAt: at },
            { name: 'Grace Hopper', email: 'grace@example.org', requestedAt: at, expiresAt: at },
          ],
          peopleUrl: 'https://reports.example.org/people',
        }),
      ],
      ['emailChangedEmail', emails.emailChangedEmail(site, { newEmail: 'new@example.org', at })],
      ['emailChangedEmail', emails.emailChangedEmail(site, { newEmail: 'new@example.org', at, byAdmin: OWNER })],
      ['passkeyAddedEmail', emails.passkeyAddedEmail(site, { at })],
      ['passwordChangedEmail', emails.passwordChangedEmail(site, { at })],
      ['accountDeletedEmail', emails.accountDeletedEmail(site, { email: EMAIL, at, comeBack: 'sign-up' })],
      ['accountDeletedEmail', emails.accountDeletedEmail(site, { email: EMAIL, at, byAdmin: OWNER, items: 'Your reports stay with the team.', comeBack: 'invite' })],
    ];
    for (const [name, email] of all) {
      rendered.add(name);
      for (const text of [email.subject, email.preheader, ...email.text.split('\n')]) if (text) texts.push({ where: `${name}(${family})`, text });
    }
    texts.push({ where: 'safeLine', text: emails.safeLine('reports.example.org', SITE) }, { where: `footerLine(${family})`, text: emails.footerLine(site) });
  }
  return { texts, rendered };
}

/** Every string literal, template (with `X` for each placeholder), and JSX text in `src/client`. */
function sourceTexts(): Text[] {
  const dir = join(ROOT, 'src/client');
  const out: Text[] = [];
  // styles.ts is CSS, not words.
  for (const name of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && n !== 'styles.ts')) {
    const file = join(dir, name);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      let text: string | undefined;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((span) => `X${span.literal.text}`).join('');
      else if (ts.isJsxText(node)) text = node.text.replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
      if (text) out.push({ where: `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** A capitalized phrase: "Try again", "Signing in…", "Passkey saved." (identifiers, paths, and CSS don't match). */
const SENTENCE = /^[A-Z][a-z’']+(?: [\w’'-]+)+[.…?!]?$|^[A-Z][a-z’']+[.…?!]$/;

/** Capitalized strings in components that no person reads on a screen. */
const NOT_SCREEN_WORDS: Record<string, string> = {
  // SignIn.tsx: the error Cognito gives for a wrong password, rebuilt for the decoy paths (ADR 0018) and
  // mapped to the deck's words by describeAuthError.
  'Incorrect username or password.': 'Cognito’s own message, matched, never shown',
};

/** JSX attributes and object properties that carry words a person reads. */
const WORD_ATTRIBUTES = /^(label|aria-label|title|placeholder|heading|intro|submitLabel|cancelLabel|alt|hint|status|busyStatus|error|message|reason)$/;

/**
 * Words written straight into a component instead of read from the copy deck: JSX text with letters,
 * and string literals given to a word-carrying attribute or property (`label="…"`, `status: '…'`).
 */
function componentWords(): string[] {
  const dir = join(ROOT, 'src/client');
  const out: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    const file = join(dir, name);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (node: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const isWords = (node: ts.Node | undefined): node is ts.StringLiteralLike => node !== undefined && ts.isStringLiteralLike(node) && /[A-Za-z]/.test(node.text);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && /[A-Za-z]/.test(node.text)) out.push(`${at(node)}: ${node.text.replace(/\s+/g, ' ').trim()}`);
      if (ts.isJsxAttribute(node) && WORD_ATTRIBUTES.test(node.name.getText()) && isWords(node.initializer)) out.push(`${at(node)}: ${node.name.getText()}="${node.initializer.text}"`);
      if (ts.isPropertyAssignment(node) && WORD_ATTRIBUTES.test(node.name.getText()) && isWords(node.initializer)) out.push(`${at(node)}: ${node.name.getText()}: '${node.initializer.text}'`);
      // Anything else that reads as a sentence or a label ("Signing in…", "Try again"), wherever it's passed.
      else if (ts.isStringLiteralLike(node) && SENTENCE.test(node.text) && !Object.hasOwn(NOT_SCREEN_WORDS, node.text) && !(ts.isJsxAttribute(node.parent) || ts.isPropertyAssignment(node.parent))) {
        out.push(`${at(node)}: '${node.text}'`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

// ---- The Oxford-comma lint ----------------------------------------------------------------------

/**
 * "A, B and C" or "A, B or C": a comma, up to four words without a comma, then "and"/"or" and a word.
 * With the serial comma ("A, B, and C") the words before the conjunction hold a comma, so it doesn't match.
 */
const SERIES_WITHOUT_OXFORD_COMMA = /\b[\w’'-]+, (?:[\w’'-]+ ){0,3}?[\w’'-]+ (?:and|or) [\w’'-]+/g;

/**
 * Real false positives: the comma ends a clause or sets off an alternative, and "and"/"or" joins two
 * words inside it. Each entry is the exact text the pattern matched.
 */
const NOT_A_SERIES: Record<string, string> = {
  // helpScreen('passkey').after: "…Codes can’t be emailed to you, so use your password and authenticator code instead."
  // A clause after the comma; "password and authenticator code" is one way in.
  'you, so use your password and authenticator': 'clause, then one factor',
  // helpScreen('email') step 1: "Have your passkey, or your password and authenticator app?" Two alternatives;
  // the second is the pair a password always comes with.
  'passkey, or your password and authenticator': 'two alternatives',
  // signInCodeEmail and passwordResetEmail: "If it keeps happening, reply and tell us." / "If you get several of
  // these, reply and tell us." A clause after the comma, with one compound verb.
  'happening, reply and tell': 'clause, compound verb',
  'these, reply and tell': 'clause, compound verb',
  // emailChangedEmail and accountDeletedEmail: "If it wasn’t, reply to this email or contact {help} right away."
  // Two alternatives in the clause after the comma.
  'wasn’t, reply to this email or contact': 'clause, two alternatives',
};

function lint(texts: readonly Text[]): string[] {
  const hits: string[] = [];
  for (const { where, text } of texts) {
    for (const match of text.matchAll(SERIES_WITHOUT_OXFORD_COMMA)) {
      if (!Object.hasOwn(NOT_A_SERIES, match[0])) hits.push(`${where}: “${match[0]}” in “${text}”`);
    }
  }
  return [...new Set(hits)];
}

describe('the Oxford-comma lint', () => {
  it('catches a series without the serial comma and passes one with it', () => {
    expect(lint([{ where: 't', text: 'Use your face, fingerprint or device PIN.' }])).toHaveLength(1);
    expect(lint([{ where: 't', text: 'Passkeys, passwords and codes.' }])).toHaveLength(1);
    expect(lint([{ where: 't', text: 'with your email, device or apps' }])).toHaveLength(1);
    expect(lint([{ where: 't', text: 'Use your face, fingerprint, or device PIN.' }])).toEqual([]);
    expect(lint([{ where: 't', text: 'Passkeys, passwords, and codes.' }])).toEqual([]);
    expect(lint([{ where: 't', text: 'a or b' }])).toEqual([]);
  });

  it('finds every allowlisted text somewhere (no stale entries)', () => {
    const all = [...copyTexts(), ...messageTexts(), ...emailTexts().texts, ...sourceTexts()].map((t) => t.text).join('\n');
    for (const entry of Object.keys(NOT_A_SERIES)) expect(all, entry).toContain(entry);
  });

  it('the rendered copy, messages, and emails use the serial comma', () => {
    expect(lint([...copyTexts(), ...messageTexts(), ...emailTexts().texts])).toEqual([]);
  });

  it('every string literal and JSX text in src/client uses the serial comma', () => {
    const texts = sourceTexts();
    expect(texts.length).toBeGreaterThan(300);
    expect(lint(texts)).toEqual([]);
  });

  it('listInWords and domainsInWords write the serial comma', () => {
    expect(listInWords(['a', 'b', 'c'])).toBe('a, b, or c');
    expect(listInWords(['a', 'b', 'c'], 'and')).toBe('a, b, and c');
    expect(listInWords(['a', 'b'])).toBe('a or b');
    expect(domainsInWords(['nc.gov', 'unc.edu', 'edu'])).toBe('nc.gov, unc.edu, or .edu');
  });
});

// ---- Coverage of the rendering ----------------------------------------------------------------

describe('every user-facing string is rendered', () => {
  it('every copy function has sample arguments, and no entry is stale', () => {
    expect(functionPaths().sort()).toEqual(Object.keys(CALLS).sort());
  });

  it('renders every copy string to non-empty text, without placeholders left over', () => {
    const texts = copyTexts();
    expect(texts.length).toBeGreaterThan(500);
    for (const { where, text } of texts) {
      expect(text.trim(), where).not.toBe('');
      expect(text, where).not.toMatch(/undefined|null|\[object Object\]|\$\{/);
    }
  });

  it('renders every email the module exports', () => {
    const exported = Object.entries(emails)
      .filter(([name, value]) => typeof value === 'function' && /Email$/.test(name) && name !== 'renderEmail' && name !== 'maskEmail')
      .map(([name]) => name);
    expect([...emailTexts().rendered].sort()).toEqual(exported.sort());
    for (const { where, text } of emailTexts().texts) expect(text, where).not.toMatch(/undefined|null|\[object Object\]/);
  });

  it('every message is a sentence that ends with a full stop', () => {
    for (const { where, text } of messageTexts()) expect(text, where).toMatch(/^[A-Z].*\.$/);
  });
});

describe('the screens read their words from the copy deck', () => {
  it('no component writes words of its own (JSX text, labels, statuses, errors)', () => {
    expect(componentWords()).toEqual([]);
  });
});

// ---- The key Card Studio strings, exactly -----------------------------------------------------

describe('Card Studio v4’s words', () => {
  const personal = context('personal');
  const osbm = context('osbm');

  it('sign in', () => {
    expect(copy.SIGN_IN.heading(personal)).toBe('Sign in to Example Reports');
    expect(copy.SIGN_IN.reauthHeading).toBe('Confirm it’s you');
    expect(copy.SIGN_IN.continue).toBe('Continue');
    expect(copy.SIGN_IN.signIn).toBe('Sign in');
    expect(copy.SIGN_IN.passkeyHeading).toBe('Use your passkey');
    expect(copy.SIGN_IN.passkeySub).toBe('Confirm with your face, fingerprint, or device PIN when your browser asks.');
    expect(copy.SIGN_IN.waitingForPasskey).toBe('Waiting for your passkey…');
    expect(copy.SIGN_IN.passwordHeading).toBe('Enter your password');
    expect(copy.SIGN_IN.forgotPassword).toBe('Forgot your password?');
    expect(copy.SIGN_IN.totpHeading).toBe('Enter your authenticator code');
    expect(copy.SIGN_IN.totpSub(personal)).toBe('Open your authenticator app or password manager and enter the 6-digit code for Example Reports.');
    expect(copy.SIGN_IN.lostAuthenticator).toBe('Lost your authenticator app?');
    expect(copy.SIGN_IN.codeHeading).toBe('Check your email');
    expect(copy.SIGN_IN.codeSub(personal, EMAIL)).toBe('If ada@example.org has an account here, we’ve emailed it an 8-digit code. It works for 3 minutes.');
    expect(copy.SIGN_IN.codeSub(context('osbm', { codeLifetimeMinutes: 10 }), EMAIL)).toBe('If ada@example.org has an account here, we’ve emailed it an 8-digit code. It works for 10 minutes.');
    expect(copy.SIGN_IN.codeHelp).toBe('No email after a minute? Check your junk folder, then send a new code. Accounts with an authenticator app can’t get emailed codes. Use your password or passkey instead.');
    expect(copy.SIGN_IN.resetCodeSub(EMAIL)).toBe('If ada@example.org has an account here, we’ve emailed it a code to reset your password. It works for 1 hour.');
    expect(copy.SIGN_IN.offerPasskeyHeading).toBe('Create a passkey on this device?');
    expect(copy.SIGN_IN.trouble).toBe('Trouble signing in?');
    expect(copy.SIGN_IN.checkFailed(personal)).toBe('We couldn’t check how you sign in. Try again. If it keeps happening, email apps-help@example.org.');
    // A password that must be reset reads like a wrong password (L5): no screen of its own.
    expect(Object.keys(copy.SIGN_IN)).not.toContain('mustChooseNewPassword');
  });

  it('the access lines', () => {
    expect(copy.ACCESS_LINE.request).toBe('Need access? Request it.');
    expect(`${copy.ACCESS_LINE.newHere} ${copy.ACCESS_LINE.createAccount}`).toBe('New here? Create an account');
    expect(copy.ACCESS_LINE.inviteOnly(personal)).toBe('New to Example Reports? It’s invite-only.');
    expect(copy.ACCESS_LINE.askToBeAdded).toBe('Ask the person who runs it to add you.');
    expect(copy.ACCESS_LINE.needAccess).toBe('Need access?');
    expect(copy.ACCESS_HELP.heading(personal)).toBe('Need access to Example Reports?');
    expect(copy.ACCESS_HELP.sub(personal)).toBe('Example Reports is invite-only. The Example Reports team adds people and sends each one an email invitation.');
    expect(copy.ACCESS_HELP.sub(osbm)).toBe('Example Reports is invite-only. Jordan Lee adds people and sends each one an email invitation.');
  });

  it('the first visit', () => {
    expect(copy.FIRST_VISIT.chooseHeading).toBe('Choose how you’ll sign in next time');
    expect(copy.FIRST_VISIT.createPasskey).toBe('Create a passkey');
    expect(copy.FIRST_VISIT.waitingForDevice).toBe('Waiting for your device…');
    expect(copy.FIRST_VISIT.createPasswordHeading).toBe('Create a password');
    expect(copy.FIRST_VISIT.addTotpHeading).toBe('Add an authenticator app');
    expect(copy.FIRST_VISIT.doneHeading).toBe('You’re set up');
    expect(copy.FIRST_VISIT.donePasskey(personal)).toBe('Next time, choose your passkey when you sign in to Example Reports.');
    expect(copy.FIRST_VISIT.continueTo(personal)).toBe('Continue to Example Reports');
  });

  it('trouble signing in: the triage list and the six help screens', () => {
    expect(copy.TROUBLE.heading).toBe('Trouble signing in?');
    expect(copy.TROUBLE.rows.map(([, label]) => label)).toEqual([
      'I can’t use my passkey',
      'I forgot my password',
      'I lost my authenticator app',
      'I didn’t get a code',
      'I can’t get into my email',
      'Something else',
    ]);
    const headings = copy.TROUBLE.rows.map(([topic]) => copy.helpScreen(topic, personal).heading);
    expect(headings).toEqual(['Can’t use your passkey?', 'Forgot your password?', 'Lost your authenticator app?', 'Didn’t get a code?', 'Can’t get into your email?', 'Something else?']);
    expect(copy.helpScreen('passkey', personal).button).toEqual({ label: 'Email me a code', action: 'email-code' });
    expect(copy.helpScreen('password', personal).button).toEqual({ label: 'Send a reset code', action: 'reset-code' });
    expect(copy.helpScreen('code', personal).button).toEqual({ label: 'Send a new code', action: 'resend-code' });
    for (const topic of ['totp', 'email', 'else'] as const) expect(copy.helpScreen(topic, personal).button).toBeUndefined();
    expect(copy.helpScreen('password', personal).after).toBeUndefined();
    expect(copy.helpScreen('password', personal, { securityNotices: true }).after).toBe('We’ll email you a note when your password changes.');
    expect(copy.helpScreen('totp', personal).intro).toBe(
      'Codes can’t be emailed to accounts that use an authenticator app, so the Example Reports team has to reset it on your Example Reports account. Then you can set up a new one.',
    );
    expect(copy.helpScreen('totp', osbm).intro).toBe('Codes can’t be emailed to accounts that use an authenticator app, so Jordan Lee has to reset it on your Example Reports account. Then you can set up a new one.');
    expect(copy.helpScreen('else', personal).intro).toBe(
      'Email us and say what’s happening, and what you see on the screen. We can help with your Example Reports account, but not with your email, device, or apps.',
    );
  });

  it('a device or browser that isn’t working: the passkey help names who helps with that (devDesk), the other screens the IT desk', () => {
    expect(copy.helpScreen('passkey', personal).after).toBe(
      'Your old passkey stays on your account until you remove it under My account. If your device or browser itself isn’t working, the device maker’s support can help with that part. Use an authenticator app? Codes can’t be emailed to you, so use your password and authenticator code instead.',
    );
    expect(copy.helpScreen('passkey', osbm).after).toContain('If your device or browser itself isn’t working, your agency’s IT help desk can help with that part.');
    expect(copy.helpScreen('passkey', context('unc')).after).toContain('If your device or browser itself isn’t working, the UNC IT help desk can help with that part.');
    // The authenticator and email screens keep the IT desk.
    for (const c of [personal, osbm, context('unc')]) {
      expect(copy.helpScreen('totp', c).after).toContain(c.theme.help.itDesk);
      expect(copy.helpScreen('email', c).intro).toContain(c.theme.help.itDesk);
    }
    expect(copy.helpScreen('totp', personal).after).not.toContain('device maker');
  });

  it('the contact box: the owner where the family names one, the Teams check for OSBM, and never a password or code', () => {
    expect(copy.contactLines(personal)).toEqual({ lead: 'Need help with your Example Reports account?', address: HELP, lines: ['Never send a password or code.'] });
    expect(copy.contactLines(osbm, { teams: true }).lines).toEqual([
      'Jordan Lee looks after Example Reports.',
      'Not sure an email is really from us? Ask Jordan Lee on Teams.',
      'Never send a password or code.',
    ]);
    expect(copy.contactLines(context('unc'), { teams: true }).lines).toEqual(['Jordan Lee looks after Example Reports.', 'Never send a password or code.']);
    expect(copy.team(personal)).toBe('the Example Reports team');
    expect(copy.Team(personal)).toBe('The Example Reports team');
    expect(copy.team(osbm)).toBe('Jordan Lee');
    expect(copy.team(context('osbm', { ownerName: undefined }))).toBe('the Example Reports team');
  });

  it('sign-up, request access, and signed out', () => {
    expect(copy.SIGN_UP.heading).toBe('Create your account');
    expect(copy.SIGN_UP.codeSub(personal, EMAIL)).toBe('We’ve emailed ada@example.org. Enter the 8-digit code from that email. It works for 3 minutes and confirms the address is yours.');
    expect(copy.SIGN_UP.codeSubmit).toBe('Continue'); // register A6: Continue on a step in between
    expect(copy.SIGN_UP.nameHeading).toBe('Your name');
    expect(copy.SIGN_UP.doneSub(personal)).toBe('Your account starts as a member of Example Reports. The Example Reports team can give you more access if you need it.');
    expect(copy.SIGN_UP.doneSub(osbm)).toBe('Your account starts as a member of Example Reports. Jordan Lee can give you more access if you need it.');
    expect(copy.SIGN_UP.termsOpen(personal).join('')).toBe('By creating an account you agree to the Example Reports terms and privacy notice.');
    expect(copy.REQUEST.heading(personal)).toBe('Request access to Example Reports');
    expect(copy.REQUEST.sentHeading).toBe('Request sent');
    expect(copy.REQUEST.sentSub).toBe('Thanks. If an admin approves, you’ll get an email invitation. If you already have an account, just sign in.');
    expect(copy.REQUEST.couldntSend).toBe('We couldn’t send your request. Check your connection and try again.');
    expect(copy.SIGNED_OUT.heading).toBe('You’re signed out everywhere');
    expect(copy.SIGNED_OUT.sub(personal)).toBe('You’ve been signed out of Example Reports on all your devices.');
    expect(copy.SELF_SERVICE.askAdmin).toBe('To change it, ask the site’s admin.');
    expect(copy.SELF_SERVICE.deleteConfirmHeading(personal)).toBe('Delete your Example Reports account?');
    expect(copy.SELF_SERVICE.deleteConfirmHeading({})).toBe('Delete your account?');
  });

  it('errors and status', () => {
    expect(copy.ERRORS.emptyEmail).toBe('Enter your email address');
    expect(copy.ERRORS.badEmail('name@osbm.nc.gov')).toBe('Enter an email address like name@osbm.nc.gov');
    expect(copy.ERRORS.passkeyCancelled).toBe('We didn’t get a passkey. Try again, or use another way below.');
    expect(copy.ERRORS.passkeyCreateFailed).toBe('We couldn’t create your passkey. Try again, or use a password instead.');
    expect(copy.ERRORS.passkeyRejected).toBe('We couldn’t sign you in with that passkey. Try again, or use another way below.');
    expect(copy.ERRORS.wrongPassword).toBe('That email address and password don’t match. Try again, or use another way to sign in.');
    expect(copy.ERRORS.wrongTotp).toBe('That code didn’t work. Codes change every 30 seconds, so enter the newest one.');
    expect(copy.ERRORS.wrongEmailCode(personal)).toBe('That code didn’t work. Check it against the newest email from Example Reports.');
    expect(copy.ERRORS.sessionExpired(personal)).toBe('That took longer than 3 minutes, so we stopped the sign-in to keep your account safe. Start again.');
    expect(copy.ERRORS.rateLimited).toBe('Too many attempts from this network. Wait 5 minutes, then try again.');
    expect(copy.ERRORS.breached).toBe('This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.');
    expect(copy.ERRORS.network(personal)).toBe('We couldn’t reach the sign-in service. Check your connection and try again. If it keeps happening, email apps-help@example.org.');
    expect(copy.ERRORS.network(undefined)).toBe('We couldn’t reach the sign-in service. Check your connection and try again.');
  });

  it('the emails’ subjects, safe line, and footer', () => {
    const site = (family: ThemeFamily): emails.EmailSite => ({ siteName: SITE, theme: authTheme(family), signInUrl: 'https://reports.example.org/sign-in', helpEmail: HELP });
    expect(emails.signInCodeEmail(site('personal'), { code: '12345678', codeLifetimeMinutes: 3 }).subject).toBe('Your Example Reports sign-in code');
    expect(emails.signUpCodeEmail(site('personal'), { code: '12345678', codeLifetimeMinutes: 3 }).subject).toBe('Your Example Reports code');
    expect(emails.passwordResetEmail(site('personal'), { code: '123456' }).subject).toBe('Reset your Example Reports password');
    expect(emails.inviteEmail(site('personal'), { email: EMAIL, expiresAt: new Date('2026-10-23T21:00:00Z'), invitedBy: { name: OWNER } }).subject).toBe('Jordan Lee invited you to Example Reports');
    expect(emails.existingAccountEmail(site('personal'), { email: EMAIL, via: 'sign-up' }).subject).toBe('You already have an Example Reports account');
    expect(emails.safeLine('reports.example.org', SITE)).toBe('Only enter codes at reports.example.org. Example Reports will never ask you for a password or code by phone, email, or text.');
    expect(emails.footerLine(site('osbm'))).toBe('This site is managed by the NC Office of State Budget and Management. Help: apps-help@example.org.');
    expect(emails.footerLine(site('unc'))).toBe('This site is managed by UNC-Chapel Hill. Help: apps-help@example.org.');
    expect(emails.footerLine(site('personal'))).toBe('Help: apps-help@example.org.');
  });
});
