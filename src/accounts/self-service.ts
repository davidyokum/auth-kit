/**
 * Members look after their own account on sign-up sites (register D4, REPORT §3.1e; ADR 0023):
 *
 * - **Delete my account.** A sign-in in the last 5 minutes, the address typed out, never the owner
 *   (ownership moves by Transfer ownership first). Their item access is removed, they're signed out
 *   everywhere, the account is deleted, and the address gets "Your account was deleted" (§5.2m).
 *   Audited as the person (`account.delete`).
 * - **Change my email address.** A sign-in in the last 5 minutes. The server sets the new address
 *   (`AdminUpdateUserAttributes`); the pool's `AttributesRequireVerificationBeforeUpdate` keeps the old
 *   one in effect while Cognito sends a code to the new one. The person enters it, the server verifies
 *   it with their own token, and the old address is told (§5.2l). Audited
 *   (`account.requestEmailChange`, then `account.changeEmail`). Cognito lets every app client write
 *   required attributes, `email` included, so someone holding a session could still start a change
 *   through Cognito's public API without this path's recent sign-in or notice; that change stays
 *   pending until the new address enters its code (ADR 0023). On these sites this replaces the admin-only email change.
 *
 * Both are refused on invite-only and request sites, where admins change addresses.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { type Fail, InputError, authFailure, contextOf, defaultRequestContext, emailOf, fail, record, text } from '../admin/action-kit.js';
import { type AuditLogStore, type AuditedRun, runAudited } from '../admin/audit.js';
import { ACCOUNT_AUDIT_ACTIONS } from '../admin/audit-actions.js';
import { describeAwsError } from '../admin/aws-errors.js';
import { CognitoAdmin, type CognitoPerson } from '../admin/cognito-admin.js';
import type { EmailSender } from '../admin/mailer.js';
import { type QuotaLimiterOptions, createQuotaLimiter } from '../admin/quota.js';
import type { ActionResult, AuditActor, AuditRequestContext, FormAction } from '../admin/types.js';
import { type AuthUser, type ServerAuth, accessTokenOf } from '../server/auth.js';
import { UnauthenticatedError } from '../server/errors.js';
import { type AccountCreationSettings, allowsSelfSignUp, mayCreateOwnAccount, normalizeAccountCreation, rateLimitAddress } from '../shared/account-creation.js';
import { type EmailSite, accountDeletedEmail, emailChangedEmail } from '../shared/emails.js';
import { ACCOUNT_CREATION_POLICY, OWNER_GROUP } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { notOnListMessage } from '../shared/account-creation.js';
import { type SignInHelpSource, helpAddressOf } from './sign-in-help.js';
import { type RateLimitStore, rateLimitKey } from './stores.js';

export interface SelfServiceConfig<G extends string = string, C extends string = string> {
  auth: ServerAuth<G, C>;
  auditLog: AuditLogStore;
  /** The same setting the preset uses. Only `domains` and `open` sites offer these. */
  accountCreation: AccountCreationSettings;
  siteName: string;
  signInUrl: string;
  theme?: AuthTheme | ThemeFamily;
  /** The help address in effect (an address, or `createSignInHelp`). */
  help: SignInHelpSource;
  /** Sends the "account deleted" and "email changed" notices. */
  mailer: EmailSender;
  /** Limits email-change requests per account (`ACCOUNT_CREATION_POLICY.rateLimits.emailChangePerAccount`; `RateLimitTable`). */
  rateLimits: RateLimitStore;
  /**
   * An email-change request takes at least this long, so an address another account uses (nothing to
   * change) and a free one (a Cognito update and two audit rows) answer alike. Default 800 ms.
   */
  minimumResponseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Removes the person's item access before the account goes (`createResourceActions(…).removeResourceMemberships`). */
  removeResourceMemberships?: (person: { sub: string; username: string; email: string }) => Promise<unknown>;
  /** What happens to a deleted person's items on this site, in one sentence, for the screen and the email (§5.2m). */
  itemsNote?: string;
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  requestContext?: () => Promise<AuditRequestContext>;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

export interface SelfServiceActions {
  /** True on sign-up sites, where members delete their own account and change their own address. */
  readonly enabled: boolean;
  deleteMyAccount(input: { confirmEmail: unknown }): Promise<ActionResult>;
  requestEmailChange(input: { newEmail: unknown }): Promise<ActionResult>;
  confirmEmailChange(input: { code: unknown }): Promise<ActionResult>;
  readonly forms: { deleteMyAccount: FormAction; requestEmailChange: FormAction; confirmEmailChange: FormAction };
}

interface Me {
  user: AuthUser;
  person: CognitoPerson;
  groups: readonly string[];
  actor: AuditActor;
  request: AuditRequestContext;
}

export function createSelfServiceActions<G extends string, C extends string>(config: SelfServiceConfig<G, C>): SelfServiceActions {
  const settings = normalizeAccountCreation(config.accountCreation);
  const enabled = allowsSelfSignUp(settings);
  const { auth, auditLog } = config;
  const theme = resolveTheme(config.theme);
  const now = config.now ?? Date.now;
  let client = config.cognito;
  let admin: CognitoAdmin | undefined;
  const cognito = () =>
    (admin ??= new CognitoAdmin((client ??= new CognitoIdentityProviderClient({ region: auth.pool.region, maxAttempts: 1 })), auth.pool.userPoolId, createQuotaLimiter(config.quota ?? {})));
  const report = (error: unknown, context: string) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken error hook must not break an action.
    }
  };
  const site = async (): Promise<EmailSite> => ({ siteName: config.siteName, theme, signInUrl: config.signInUrl, helpEmail: await helpAddressOf(config.help) });
  const NOT_HERE = `On ${config.siteName}, the people who run the site change accounts. Ask them.`;
  if (enabled && typeof config.rateLimits?.hit !== 'function') throw new Error('auth-kit: createSelfServiceActions needs rateLimits (createDynamoRateLimitStore) on a sign-up site.');

  /** The signed-in person, live: enabled, their groups, and their account as Cognito has it now. */
  async function me(options: { recent: boolean }): Promise<Me | Fail> {
    if (!enabled) return fail('refused', NOT_HERE, { guardrail: 'not_available' });
    try {
      const user = await auth.requireUser();
      const live = await auth.liveState(user);
      if (!live.enabled) throw new UnauthenticatedError('account_disabled', 'This account is disabled.');
      if (options.recent) auth.requireRecentSignIn(user);
      const person = await cognito().findBySub(user.sub);
      if (!person) return fail('not_found', 'Your account no longer exists.');
      const request = await (config.requestContext ?? defaultRequestContext)().catch((): AuditRequestContext => ({}));
      return {
        user,
        person,
        groups: live.groups,
        actor: { sub: user.sub, ...(person.email && { email: person.email }) },
        request: { ...request, requestId: request.requestId ?? globalThis.crypto.randomUUID() },
      };
    } catch (error) {
      return authFailure(error) ?? fail('unavailable', `Couldn't check your account: ${describeAwsError(error)} Nothing was changed.`);
    }
  }

  function finished<T>(run: AuditedRun<T>, ok: (value: T) => string, failed: (error: unknown) => Fail): ActionResult {
    switch (run.kind) {
      case 'not-started':
        report(run.error, 'audit: intent write failed');
        return fail('audit_unavailable', "Couldn't write the audit log, so nothing was changed. Try again in a moment.");
      case 'failed':
        return { ...failed(run.error), changed: run.changed ? 'partly' : 'nothing', auditId: run.intent.id };
      case 'done':
        if (!run.result) report(run.resultError, 'audit: result write failed');
        return { ok: true, message: ok(run.value), ...(run.result !== undefined && { auditId: run.result.id }) };
    }
  }

  // ---- Delete my account ------------------------------------------------------------------------

  async function deleteMyAccount(input: unknown): Promise<ActionResult> {
    const who = await me({ recent: true });
    if ('ok' in who) return who;
    if (who.groups.includes(OWNER_GROUP)) {
      return fail('refused', `You’re the owner of ${config.siteName}, so your account can’t be deleted. Transfer ownership first.`, { guardrail: 'owner' });
    }
    let typed: string;
    try {
      typed = (text(record(input).confirmEmail, 'Email', 254) ?? '').toLowerCase();
    } catch {
      typed = '';
    }
    if (typed !== who.person.email.toLowerCase()) return fail('invalid', 'Type your email address exactly as it is to confirm.');
    const person = who.person;
    const items = config.itemsNote?.trim();
    const run = await runAudited(auditLog, {
      intent: {
        actor: who.actor,
        action: ACCOUNT_AUDIT_ACTIONS.deleteOwnAccount,
        target: { sub: person.sub, email: person.email },
        before: { email: person.email, groups: [...who.groups] },
        after: null,
        calls: [...(config.removeResourceMemberships ? ['Remove item access'] : []), 'AdminUserGlobalSignOut', 'AdminDeleteUser', 'SES SendEmail'],
        ...contextOf(who.request),
      },
      run: async (steps) => {
        let memberships: unknown;
        if (config.removeResourceMemberships) {
          memberships = await steps.call('Remove item access', () => config.removeResourceMemberships!({ sub: person.sub, username: person.username, email: person.email }));
        }
        await steps.call('AdminUserGlobalSignOut', () => cognito().globalSignOut(person.username));
        await steps.call('AdminDeleteUser', () => cognito().deleteUser(person.username));
        auth.invalidate({ username: person.username, sub: person.sub, tokenId: who.user.tokenId });
        try {
          const s = await site();
          await steps.call('SES SendEmail', () =>
            config.mailer.sendEmail({
              to: [person.email],
              email: accountDeletedEmail(s, { email: person.email, at: new Date(now()), ...(items && { items }), comeBack: 'sign-up' }),
              replyTo: [s.helpEmail],
            }),
          );
        } catch (error) {
          // The account is gone either way; the notice's failure is in the result row and the error hook.
          report(error, 'delete: the account-deleted email');
        }
        return { value: undefined, after: { deleted: true, ...(memberships !== undefined && { resourceMemberships: memberships }) } };
      },
    });
    return finished(
      run,
      () => `Your ${config.siteName} account is deleted, and you’re signed out everywhere.${items ? ` ${items}` : ''}`,
      (error) => fail('failed', `${describeAwsError(error)} Your account wasn’t deleted; try again.`),
    );
  }

  // ---- Change my email address --------------------------------------------------------------------

  async function requestEmailChange(input: unknown): Promise<ActionResult> {
    const started = now();
    const result = await requestEmailChangeNow(input);
    const wait = (config.minimumResponseMs ?? ACCOUNT_CREATION_POLICY.minimumResponseMs) - (now() - started);
    if (wait > 0) await (config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(wait);
    return result;
  }

  async function requestEmailChangeNow(input: unknown): Promise<ActionResult> {
    const who = await me({ recent: true });
    if ('ok' in who) return who;
    let newEmail: string;
    try {
      newEmail = emailOf(record(input).newEmail);
    } catch {
      return fail('invalid', `Enter an email address like ${theme.emailHint}`);
    }
    if (newEmail === who.person.email.toLowerCase()) return fail('invalid', 'That’s already your email address.');
    if (!mayCreateOwnAccount(newEmail, settings)) return fail('refused', notOnListMessage(config.siteName, settings.domains, false), { guardrail: 'domain' });
    try {
      // Per account, and per new address (by the mailbox it reaches): many accounts can't flood one inbox with codes.
      const at = new Date(now());
      const [perAccount, perTarget] = await Promise.all([
        config.rateLimits.hit(rateLimitKey('email-change:account', who.user.sub), ACCOUNT_CREATION_POLICY.rateLimits.emailChangePerAccount, at),
        config.rateLimits.hit(rateLimitKey('email-change:target', rateLimitAddress(newEmail)), ACCOUNT_CREATION_POLICY.rateLimits.emailChangePerTarget, at),
      ]);
      const over = [perAccount, perTarget].find((hit) => !hit.allowed);
      if (over) return fail('refused', `Too many attempts. Wait ${Math.max(1, Math.ceil(over.retryAfterSeconds / 60))} minutes, then try again.`, { guardrail: 'rate_limited' });
    } catch (error) {
      report(error, 'email change: rate limit');
      return fail('unavailable', 'We couldn’t check this request just now. Try again in a few minutes. Nothing was changed.');
    }
    const sent = `We’ve emailed a code to ${newEmail}. Enter it to finish. Your email address changes only after you do.`;
    let taken: CognitoPerson | null;
    try {
      taken = await cognito().findByEmail(newEmail);
    } catch (error) {
      return fail('unavailable', `Couldn't check that address: ${describeAwsError(error)} Nothing was changed.`);
    }
    // An address another account uses gets the same answer and nothing else: a code never arrives.
    if (taken) return { ok: true, message: sent };
    const person = who.person;
    const run = await runAudited(auditLog, {
      intent: {
        actor: who.actor,
        action: ACCOUNT_AUDIT_ACTIONS.requestOwnEmailChange,
        target: { sub: person.sub, email: person.email },
        before: { email: person.email },
        after: { email: person.email, pendingEmail: newEmail },
        calls: ['AdminUpdateUserAttributes email (pending until verified)'],
        ...contextOf(who.request),
      },
      run: async (steps) => {
        await steps.call('AdminUpdateUserAttributes email (pending until verified)', () => cognito().updateEmail(person.username, newEmail));
        return { value: undefined };
      },
    });
    const result = finished(run, () => sent, (error) => fail('failed', `${describeAwsError(error)} Nothing was changed.`));
    // No audit ID on the screen: an address another account uses gets this exact answer, with none.
    return result.ok ? { ok: true, message: sent } : result;
  }

  async function confirmEmailChange(input: unknown): Promise<ActionResult> {
    const who = await me({ recent: false });
    if ('ok' in who) return who;
    let code: string;
    try {
      code = (text(record(input).code, 'Code', 20) ?? '').replace(/[\s-]/g, '');
      if (!/^\d{6,8}$/.test(code)) throw new InputError('Enter the code from the email');
    } catch {
      return fail('invalid', 'Enter the code from the email');
    }
    const accessToken = accessTokenOf(who.user);
    if (!accessToken) return fail('unauthenticated', 'Your session has ended. Sign in again.');
    const before = who.person;
    const run = await runAudited(auditLog, {
      intent: {
        actor: who.actor,
        action: ACCOUNT_AUDIT_ACTIONS.changeOwnEmail,
        target: { sub: before.sub, email: before.email },
        before: { email: before.email },
        calls: ['VerifyUserAttribute email', 'SES SendEmail (to the old address)'],
        ...contextOf(who.request),
      },
      run: async (steps) => {
        await steps.call('VerifyUserAttribute email', () => cognito().verifyEmailWithToken(accessToken, code));
        const after = await cognito().findBySub(before.sub);
        const newEmail = after?.email ?? '';
        if (!after || newEmail.toLowerCase() === before.email.toLowerCase()) {
          throw Object.assign(new Error('There was no pending change to that address.'), { name: 'NoPendingChange' });
        }
        auth.invalidate({ username: before.username, sub: before.sub, tokenId: who.user.tokenId });
        try {
          const s = await site();
          await steps.call('SES SendEmail (to the old address)', () =>
            config.mailer.sendEmail({ to: [before.email], email: emailChangedEmail(s, { newEmail, at: new Date(now()) }), replyTo: [s.helpEmail] }),
          );
        } catch (error) {
          report(error, 'email change: the notice to the old address');
        }
        return { value: newEmail, target: { sub: before.sub, email: newEmail }, after: { email: newEmail } };
      },
    });
    return finished(
      run,
      (newEmail) => `Your email address is now ${newEmail}. Sign in with it from now on.`,
      (error) => {
        const name = (error as { name?: string }).name;
        if (name === 'CodeMismatchException' || name === 'NoPendingChange') return fail('invalid', `That code didn’t work. Check it against the newest email from ${config.siteName}.`);
        if (name === 'ExpiredCodeException') return fail('invalid', 'That code has expired. Ask for a new one.');
        return fail('failed', `${describeAwsError(error)} Your email address didn’t change.`);
      },
    );
  }

  const fromForm = (data: FormData): Record<string, unknown> => Object.fromEntries([...data.entries()].filter(([, v]) => typeof v === 'string'));
  return {
    enabled,
    deleteMyAccount,
    requestEmailChange,
    confirmEmailChange,
    forms: {
      deleteMyAccount: (_p, data) => deleteMyAccount(fromForm(data)),
      requestEmailChange: (_p, data) => requestEmailChange(fromForm(data)),
      confirmEmailChange: (_p, data) => confirmEmailChange(fromForm(data)),
    },
  };
}
