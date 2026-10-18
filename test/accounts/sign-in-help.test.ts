import { ListUsersInGroupCommand, type ListUsersInGroupCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import {
  SITE_SETTING,
  type SiteSettingsStore,
  createMemorySiteSettingsStore,
  createSignInHelp,
  createSignInHelpActions,
} from '../../src/accounts/index.js';
import { type AuditEvent, type AuditLogStore, type SignInHelpChangedAlert, createMemoryAuditLog } from '../../src/admin/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { HELP_ADDRESS_PLACEHOLDER } from '../../src/themes/index.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';
import { awsError, fakeUserPool, NOW } from '../admin/people-fixture.js';

const SITE = 'Budget Reports';
const CONFIGURED = 'help@example.org';
const NEW_HELP = 'reports-help@example.org';
const REASON = 'The reports team answers sign-in questions now';
const SUPER = { sub: 'super-1', groups: ['superadmin'] };
const BY = { sub: 'super-1' };

/** A settings store whose reads can be made to fail. */
function flakyStore() {
  const store = createMemorySiteSettingsStore();
  const state = { failGets: 0, gets: 0 };
  const flaky: SiteSettingsStore = {
    get(name) {
      state.gets++;
      if (state.failGets > 0) {
        state.failGets--;
        return Promise.reject(awsError('InternalServerError', 'DynamoDB is unavailable'));
      }
      return store.get(name);
    },
    put: (name, input) => store.put(name, input),
    remove: (name, version) => store.remove(name, version),
  };
  return { store: flaky, state };
}

const put = (store: SiteSettingsStore, value: unknown, expectedVersion = 0) => store.put(SITE_SETTING.signInHelp, { value, expectedVersion, by: BY, now: new Date(NOW) });

describe('createSignInHelp', () => {
  it('refuses a configured address that can’t be the help mailbox', () => {
    expect(() => createSignInHelp({ configured: HELP_ADDRESS_PLACEHOLDER })).toThrow(/placeholder/);
    expect(() => createSignInHelp({ configured: 'help@reports.test' })).toThrow(/placeholder/);
    expect(() => createSignInHelp({ configured: 'jordan.lee@example.org' })).toThrow(/a person's own address/);
    expect(() => createSignInHelp({ configured: '' })).toThrow(/needs a help address/);
    expect(createSignInHelp({ configured: ' Help@Example.org ' }).configured).toBe(CONFIGURED);
  });

  it('falls back to the configured address: no store, nothing stored, or an unusable stored value', async () => {
    expect(await createSignInHelp({ configured: CONFIGURED }).effective()).toEqual({ address: CONFIGURED, source: 'config' });
    expect(await createSignInHelp({ configured: CONFIGURED, store: createMemorySiteSettingsStore() }).effective()).toEqual({ address: CONFIGURED, source: 'config' });
    for (const value of [{ address: HELP_ADDRESS_PLACEHOLDER }, { address: 'jordan.lee@example.org' }, { address: 'not an address' }, { address: 42 }, 'help@example.net', null]) {
      const store = createMemorySiteSettingsStore();
      await put(store, value);
      expect(await createSignInHelp({ configured: CONFIGURED, store }).effective(), JSON.stringify(value)).toEqual({ address: CONFIGURED, source: 'config' });
    }
  });

  it('a store that can’t be read falls back, tells onError, and isn’t cached', async () => {
    const { store, state } = flakyStore();
    await put(store, { address: NEW_HELP });
    const errors: unknown[] = [];
    const help = createSignInHelp({ configured: CONFIGURED, store, onError: (e) => void errors.push(e) });
    state.failGets = 1;
    expect(await help.effective()).toEqual({ address: CONFIGURED, source: 'config' });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe('InternalServerError');
    // The next read tries the store again.
    expect(await help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
    expect(state.gets).toBe(2);
  });

  it('uses a stored override, cached for cacheSeconds', async () => {
    const { store, state } = flakyStore();
    const clock = { t: NOW };
    await put(store, { address: NEW_HELP, reason: REASON });
    const help = createSignInHelp({ configured: CONFIGURED, store, cacheSeconds: 30, now: () => clock.t });
    expect(await help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
    await put(store, { address: 'apps-help@example.org' }, 1);
    clock.t += 29_000;
    expect(await help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
    expect(state.gets).toBe(1);
    clock.t += 2_000;
    expect(await help.effective()).toEqual({ address: 'apps-help@example.org', source: 'override' });
    expect(state.gets).toBe(2);
    // invalidate() forgets it at once.
    await put(store, { address: NEW_HELP }, 2);
    help.invalidate();
    expect(await help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
  });

  it('view() shows the stored override, and says honestly when it couldn’t read one', async () => {
    expect(await createSignInHelp({ configured: CONFIGURED }).view()).toEqual({
      state: 'ok',
      configured: CONFIGURED,
      override: null,
      effective: { address: CONFIGURED, source: 'config' },
      version: 0,
    });

    const { store, state } = flakyStore();
    await put(store, { address: NEW_HELP, reason: REASON });
    const help = createSignInHelp({ configured: CONFIGURED, store });
    expect(await help.view()).toEqual({
      state: 'ok',
      configured: CONFIGURED,
      override: { address: NEW_HELP, updatedAt: new Date(NOW).toISOString(), updatedBy: BY, reason: REASON },
      effective: { address: NEW_HELP, source: 'override' },
      version: 1,
    });

    state.failGets = 1;
    const unavailable = await help.view();
    expect(unavailable).toMatchObject({ state: 'unavailable', configured: CONFIGURED });
    expect(unavailable.state === 'unavailable' && unavailable.reason).toMatch(/^Couldn't read the help setting: .* The configured address \(help@example\.org\) is in effect\.$/);

    // A stored value that's no longer usable is shown, and isn't in effect.
    const bad = createMemorySiteSettingsStore();
    await put(bad, { address: HELP_ADDRESS_PLACEHOLDER });
    expect(await createSignInHelp({ configured: CONFIGURED, store: bad }).view()).toMatchObject({
      state: 'ok',
      override: { address: HELP_ADDRESS_PLACEHOLDER },
      effective: { address: CONFIGURED, source: 'config' },
    });
  });
});

interface HelpActor {
  sub: string;
  groups: string[];
  liveGroups?: string[];
  enabled?: boolean;
  authTimeAgoSeconds?: number;
}

/** Real server auth, the fake pool (with the owner to alert), the settings store, and a recording owner alert. */
function setupActions(options: { actor?: HelpActor; ownerAlerts?: boolean } = {}) {
  const timeline: string[] = [];
  const pool = fakeUserPool({ timeline });
  pool.add({ sub: 'owner-1', email: 'owner@example.org', name: 'Olive Owner' }, 'owner');
  pool.add({ sub: 'owner-old', email: 'old-owner@example.org', enabled: false }, 'owner');
  // A peer Super admin (told of every change), and one who's disabled (not told).
  pool.add({ sub: 'super-2', email: 'super2@example.org', name: 'Sam Super' }, 'superadmin');
  pool.add({ sub: 'super-old', email: 'old-super@example.org', enabled: false }, 'superadmin');
  let token: string | null = null;
  const h = harness({ context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }) });
  const clock = { t: NOW };
  const memory = createMemoryAuditLog({ now: () => clock.t });
  const auditLog: AuditLogStore & { readonly rows: readonly AuditEvent[] } = {
    async append(e) {
      const row = await memory.append(e);
      timeline.push(`audit:${row.phase}`);
      return row;
    },
    list: (q) => memory.list(q),
    listActivity: (q) => memory.listActivity(q),
    get rows() {
      return memory.rows;
    },
  };
  const store = createMemorySiteSettingsStore();
  const help = createSignInHelp({ configured: CONFIGURED, store, now: () => clock.t });
  const alerts: SignInHelpChangedAlert[] = [];
  const alertFailures: Error[] = [];
  const ownerAlerts = {
    signInHelpChanged(alert: SignInHelpChangedAlert) {
      timeline.push('mail:signInHelpChanged');
      const failure = alertFailures.shift();
      if (failure) return Promise.reject(failure);
      alerts.push(alert);
      return Promise.resolve();
    },
  };
  const errors: string[] = [];
  const signIn = (actor: HelpActor) => {
    h.cognito.setLiveState(actor.sub, { enabled: actor.enabled ?? true, groups: actor.liveGroups ?? actor.groups });
    const nowSec = Math.floor(h.clock.now / 1000);
    token = h.issuer.mintAccessToken({ sub: actor.sub, groups: actor.groups, authTime: nowSec - (actor.authTimeAgoSeconds ?? 30) });
  };
  signIn(options.actor ?? SUPER);
  const actions = createSignInHelpActions<AppGroup, AppCapability>({
    auth: h.auth,
    auditLog,
    help,
    siteName: SITE,
    ...(options.ownerAlerts !== false && { ownerAlerts }),
    cognito: pool.client,
    quota: { random: () => 0 },
    requestContext: () => Promise.resolve({ ip: '203.0.113.24', userAgent: 'Test Browser', requestId: 'req-test' }),
    now: () => clock.t,
    onError: (_e, where) => void errors.push(where),
  });
  return {
    actions,
    pool,
    help,
    store,
    auditLog,
    alerts,
    errors,
    timeline,
    failAlert: (e: Error = awsError('MessageRejected', 'Email address is not verified.')) => void alertFailures.push(e),
  };
}

describe('Settings → Sign-in help (the Super admin’s override)', () => {
  it('needs createSignInHelp with a store', () => {
    const h = harness();
    expect(() =>
      createSignInHelpActions({ auth: h.auth, auditLog: createMemoryAuditLog(), help: createSignInHelp({ configured: CONFIGURED }), siteName: SITE }),
    ).toThrow(/needs createSignInHelp\(\{ configured, store \}\) with a store/);
  });

  it('needs settings.security: an admin who manages content and people can neither open nor change it', async () => {
    const t = setupActions({ actor: { sub: 'acp-1', groups: ['admin-content-people'] } });
    expect(await t.actions.get()).toEqual({ state: 'forbidden', reason: "You don't have permission to do that." });
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await t.actions.clear({ reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(t.auditLog.rows).toEqual([]);
    expect(t.alerts).toEqual([]);

    const s = setupActions();
    expect(await s.actions.get()).toMatchObject({ state: 'ok', configured: CONFIGURED, override: null, version: 0 });
  });

  it('checks the role live: a token that still says Super admin isn’t enough', async () => {
    const demoted = setupActions({ actor: { ...SUPER, liveGroups: ['admin-content-people'] } });
    expect(await demoted.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'forbidden' });
    const disabled = setupActions({ actor: { ...SUPER, enabled: false } });
    expect(await disabled.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await demoted.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(await disabled.store.get(SITE_SETTING.signInHelp)).toBeNull();
  });

  it('needs a sign-in in the last 5 minutes', async () => {
    const t = setupActions({ actor: { ...SUPER, authTimeAgoSeconds: 6 * 60 } });
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'step_up_required', maxAgeSeconds: 300 });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
  });

  it('needs a reason, a usable address, and the version the page read', async () => {
    const t = setupActions();
    const noReason = { ok: false, code: 'invalid', error: 'Give a reason (it goes in the audit log and the owner’s alert).' };
    expect(await t.actions.set({ address: NEW_HELP, reason: 'ok', version: 0 })).toMatchObject(noReason);
    expect(await t.actions.set({ address: NEW_HELP, reason: '', version: 0 })).toMatchObject(noReason);
    expect(await t.actions.set({ address: HELP_ADDRESS_PLACEHOLDER, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/placeholder/) as string });
    expect(await t.actions.set({ address: 'jordan.lee@example.org', reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/person's own address/) as string });
    expect(await t.actions.set({ address: 'nobody', reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/isn't an email address/) as string });
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 'x' })).toMatchObject({ ok: false, code: 'invalid', error: 'Reload the page and try again.' });
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 1 })).toMatchObject({
      ok: false,
      code: 'stale',
      error: 'The sign-in help address changed since this page loaded. Reload and try again.',
    });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(t.auditLog.rows).toEqual([]);
    expect(t.alerts).toEqual([]);
  });

  it('is refused when no owner alert is configured', async () => {
    const t = setupActions({ ownerAlerts: false });
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'refused', guardrail: 'owner_alert_unavailable' });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(t.auditLog.rows).toEqual([]);
  });

  it('sets the override, alerts every enabled owner, logs it around the write, and it takes effect at once', async () => {
    const t = setupActions();
    expect(await t.help.effective()).toEqual({ address: CONFIGURED, source: 'config' }); // now cached
    const result = await t.actions.set({ address: ' Reports-Help@Example.org ', reason: REASON, version: 0 });
    expect(result).toMatchObject({ ok: true, message: `People who need help signing in are now sent to ${NEW_HELP}. The owner and every Super admin have been told.` });

    expect(await t.store.get(SITE_SETTING.signInHelp)).toMatchObject({ value: { address: NEW_HELP, reason: REASON }, version: 1, updatedBy: { sub: 'super-1' } });
    expect(await t.help.effective()).toEqual({ address: NEW_HELP, source: 'override' });

    expect(t.alerts).toEqual([
      {
        siteName: SITE,
        owners: [{ sub: 'owner-1', email: 'owner@example.org', name: 'Olive Owner' }],
        superAdmins: [{ sub: 'super-2', email: 'super2@example.org', name: 'Sam Super' }],
        changedBy: { sub: 'super-1' },
        from: CONFIGURED,
        to: NEW_HELP,
        reverted: false,
        reason: REASON,
        at: new Date(NOW),
        context: { ip: '203.0.113.24', userAgent: 'Test Browser', requestId: 'req-test' },
      },
    ]);
    // The owner is read live (the disabled former owner isn't told).
    expect(t.pool.inputsOf<ListUsersInGroupCommandInput>(ListUsersInGroupCommand)).toEqual([expect.objectContaining({ GroupName: 'owner' }), expect.objectContaining({ GroupName: 'superadmin' })]);
    expect(t.timeline.filter((x) => !x.startsWith('cognito:'))).toEqual(['audit:intent', 'mail:signInHelpChanged', 'audit:result']);

    const [intent, row] = t.auditLog.rows;
    expect(t.auditLog.rows).toHaveLength(2);
    expect(intent).toMatchObject({
      phase: 'intent',
      action: 'settings.signInHelp',
      actor: { sub: 'super-1' },
      before: { address: CONFIGURED, source: 'config' },
      after: { address: NEW_HELP, source: 'override' },
      reason: REASON,
      requestId: 'req-test',
    });
    expect(row).toMatchObject({
      phase: 'result',
      outcome: 'ok',
      action: 'settings.signInHelp',
      calls: ['DynamoDB PutItem sign-in help: ok', 'Owner alert (sign-in help changed): ok'],
    });
  });

  it('an alert that fails undoes the write (nothing was set before): the configured address is back', async () => {
    const t = setupActions();
    t.failAlert();
    const result = await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing' });
    expect(!result.ok && result.error).toMatch(/Nothing was changed\.$/);
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(await t.help.effective()).toEqual({ address: CONFIGURED, source: 'config' });
    expect(t.alerts).toEqual([]);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      phase: 'result',
      outcome: 'failed',
      calls: ['DynamoDB PutItem sign-in help: ok', 'Owner alert (sign-in help changed): failed (MessageRejected)', 'Restore the previous sign-in help (rollback): ok'],
    });
  });

  it('an alert that fails undoes the write (an override was set before): the previous override is back', async () => {
    const t = setupActions();
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: true });
    t.failAlert();
    expect(await t.actions.set({ address: 'apps-help@example.org', reason: 'Moving to the shared mailbox', version: 1 })).toMatchObject({ ok: false, code: 'failed', changed: 'nothing' });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toMatchObject({ value: { address: NEW_HELP, reason: REASON } });
    expect(await t.help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
    expect(t.alerts.map((a) => a.to)).toEqual([NEW_HELP]);
  });

  it('clear goes back to the configured address and tells the owner it reverted', async () => {
    const t = setupActions();
    expect(await t.actions.set({ address: NEW_HELP, reason: REASON, version: 0 })).toMatchObject({ ok: true });
    expect(await t.help.effective()).toEqual({ address: NEW_HELP, source: 'override' });
    const result = await t.actions.clear({ reason: 'The reports team mailbox is closing', version: 1 });
    expect(result).toMatchObject({ ok: true, message: `The sign-in help address is back to the site's configured address, ${CONFIGURED}. The owner and every Super admin have been told.` });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(await t.help.effective()).toEqual({ address: CONFIGURED, source: 'config' });
    expect(t.alerts.at(-1)).toMatchObject({ from: NEW_HELP, to: CONFIGURED, reverted: true, reason: 'The reports team mailbox is closing' });
    expect(t.auditLog.rows.at(-2)).toMatchObject({
      phase: 'intent',
      action: 'settings.signInHelp',
      before: { address: NEW_HELP, source: 'override' },
      after: { address: CONFIGURED, source: 'config' },
      calls: ['DynamoDB DeleteItem sign-in help', 'Owner alert (sign-in help changed)'],
    });
    expect(t.auditLog.rows.at(-1)).toMatchObject({ phase: 'result', outcome: 'ok' });
  });

  it('clear when nothing is set is refused', async () => {
    const t = setupActions();
    expect(await t.actions.clear({ reason: REASON, version: 0 })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'no_change',
      error: 'The configured address is already in effect.',
    });
    expect(t.auditLog.rows).toEqual([]);
    expect(t.alerts).toEqual([]);
  });
});

describe('the override stays on allowed domains (M8)', () => {
  it('allows the configured address’s domain, the family’s domains (subdomains too), and allowedDomains; nothing else', () => {
    const osbm = createSignInHelp({ configured: 'apps-help@osbm.nc.gov', theme: 'osbm' });
    expect(osbm.allowedDomains).toEqual(['osbm.nc.gov', 'nc.gov']);
    expect(osbm.overrideProblems('help@dhhs.nc.gov')).toEqual([]);
    expect(osbm.overrideProblems('help@not-our-desk.net')[0]).toMatch(/must be on osbm\.nc\.gov, nc\.gov/);
    expect(osbm.overrideProblems('help@evilnc.gov')[0]).toMatch(/must be on/);
    const personal = createSignInHelp({ configured: CONFIGURED });
    expect(personal.allowedDomains).toEqual(['example.org']);
    expect(personal.overrideProblems('desk@help.example.org')).toEqual([]);
    expect(personal.overrideProblems('desk@example.net')[0]).toMatch(/allowedDomains/);
    expect(createSignInHelp({ configured: CONFIGURED, allowedDomains: ['desk.example.net'] }).overrideProblems('help@desk.example.net')).toEqual([]);
  });

  it('a stored override off the list (written straight into the table, or a list narrowed since) falls back to the configured address', async () => {
    const store = createMemorySiteSettingsStore();
    await store.put(SITE_SETTING.signInHelp, { value: { address: 'help@not-our-desk.net', reason: 'x' }, expectedVersion: 0, by: { sub: 'x' }, now: new Date(NOW) });
    const help = createSignInHelp({ configured: CONFIGURED, store });
    expect(await help.effective()).toEqual({ address: CONFIGURED, source: 'config' });
    expect(await help.view()).toMatchObject({ state: 'ok', effective: { address: CONFIGURED, source: 'config' } });
  });

  it('a Super admin can’t set an outside address, or one whose local part changes the mailto: link', async () => {
    const t = setupActions();
    expect(await t.actions.set({ address: 'help@not-our-desk.net', reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/must be on example\.org/) as string });
    expect(await t.actions.set({ address: 'help?subject=Send+your+code@example.org', reason: REASON, version: 0 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await t.store.get(SITE_SETTING.signInHelp)).toBeNull();
    expect(t.alerts).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
  });
});

