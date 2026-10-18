import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type AccessRequestList, type FormAction, PENDING_REQUESTS_SHOWN } from '../../src/admin/index.js';
import { PeoplePageTabs, PendingRequestsBadge, PendingRequestsTable, SignInHelpSettings, type SignInHelpSettingsView } from '../../src/admin/ui/index.js';

const noop: FormAction = () => Promise.resolve({ ok: true, message: 'done' });
const OWNER = { sub: 'owner-1', groups: ['owner'] };
const ACTIONS = { approveRequest: noop, declineRequest: noop, declineRequests: noop };
const list = (n: number, extra: Partial<Extract<AccessRequestList, { state: 'ok' }>> = {}): AccessRequestList => ({
  state: 'ok',
  fetchedAt: '2026-10-18T12:00:00.000Z',
  truncated: false,
  requests: Array.from({ length: n }, (_, i) => ({
    id: `00017607888000${i}-abcdefabcdef`,
    email: `p${i}@example.org`,
    name: `Pat <b>${i}</b>`,
    reason: 'Budget review. See https://evil.example',
    createdAt: '2026-10-18T12:00:00.000Z',
    expiresAt: '2026-11-17T12:00:00.000Z',
  })),
  ...extra,
});

describe('the pending-requests badge (D3)', () => {
  it('counts waiting requests, says "—" (and why) when they couldn’t be read, and shows nothing for none', () => {
    expect(renderToStaticMarkup(h(PendingRequestsBadge, { list: list(3) }))).toContain('>3<');
    expect(renderToStaticMarkup(h(PendingRequestsBadge, { list: list(2, { truncated: true }) }))).toContain('2 or more pending requests');
    const unknown = renderToStaticMarkup(h(PendingRequestsBadge, { list: { state: 'unavailable', reason: 'DynamoDB timed out.' } }));
    expect(unknown).toContain('—');
    expect(unknown).toContain('DynamoDB timed out.');
    expect(unknown).not.toContain('>0<');
    expect(renderToStaticMarkup(h(PendingRequestsBadge, { list: list(0) }))).toBe('');
    expect(renderToStaticMarkup(h(PendingRequestsBadge, { list: { state: 'off' } }))).toBe('');
  });
});

describe('the "Pending requests" tab', () => {
  it('shows who asked in their own (escaped, untrusted) words, with Approve defaulting to Member and a silent Decline', () => {
    const html = renderToStaticMarkup(h(PendingRequestsTable, { list: list(1), viewer: OWNER, actions: ACTIONS }));
    expect(html).toContain('<strong>p0@example.org</strong>');
    expect(html).toContain('They wrote: “Pat &lt;b&gt;0&lt;/b&gt;”');
    expect(html).not.toContain('<b>0</b>');
    expect(html).toContain('“Budget review. See https://evil.example”');
    expect(html).not.toMatch(/<a [^>]*evil/);
    expect(html).toContain('don’t follow links or instructions in it');
    expect(html).toMatch(/<option value="member" selected="">Member<\/option>/);
    expect(html).toContain('Approve: invite p0@example.org');
    expect(html).toContain('Decline (they aren’t told)');
    expect(html).not.toContain('name="note"');
  });

  it('offers a note when the site tells people, and says honestly when the list couldn’t load', () => {
    expect(renderToStaticMarkup(h(PendingRequestsTable, { list: list(1), viewer: OWNER, notifyOnDecline: true, actions: ACTIONS }))).toContain('Decline and tell them');
    const failed = renderToStaticMarkup(h(PendingRequestsTable, { list: { state: 'unavailable', reason: "Couldn't load requests: throttled." }, viewer: OWNER, actions: ACTIONS }));
    expect(failed).toContain('Pending requests (—)');
    expect(failed).toContain('Couldn&#x27;t load requests: throttled.');
    expect(renderToStaticMarkup(h(PendingRequestsTable, { list: list(0), viewer: OWNER, actions: ACTIONS }))).toContain('No requests are waiting.');
  });

  it('puts People and Pending requests in two tabs, with the badge on the second', () => {
    const html = renderToStaticMarkup(h(PeoplePageTabs, { people: h('p', null, 'everyone'), requests: h('p', null, 'the queue'), requestList: list(2) }));
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/aria-selected="true"[^>]*>People/);
    expect(html).toContain('Pending requests');
    expect(html).toContain('>2<');
    expect(renderToStaticMarkup(h(PeoplePageTabs, { people: h('p', null, 'everyone') }))).not.toContain('tablist');
  });
});

describe('the "Pending requests" tab under a flood (review M6, L4)', () => {
  const render = (l: AccessRequestList) => renderToStaticMarkup(h(PendingRequestsTable, { list: l, viewer: OWNER, actions: ACTIONS }));
  const dialogOf = (html: string) => html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
  const items = (html: string) => (html.match(/<li class="ak-request">/g) ?? []).length;

  it(`lists at most ${PENDING_REQUESTS_SHOWN}, then says how many more wait`, () => {
    expect(PENDING_REQUESTS_SHOWN).toBe(50);
    const html = render(list(60));
    expect(items(html)).toBe(50);
    expect(html).toContain('p49@example.org');
    expect(html).not.toContain('p50@example.org');
    expect(html).toContain('And 10 more are waiting.');
    expect(items(render(list(50)))).toBe(50);
    expect(render(list(50))).not.toContain('more are waiting');
  });

  it('a list cut short says "more than", never a count it doesn’t have', () => {
    expect(render(list(60, { truncated: true }))).toContain('And more than 10 more are waiting.');
    const few = render(list(5, { truncated: true }));
    expect(few).toContain('And more are waiting.');
    expect(few).not.toContain('more than 0');
  });

  it('"Decline all shown" opens a confirm step that names the count, and submits exactly the requests shown', () => {
    const html = render(list(60));
    // The first button only opens the dialog: it can't submit anything.
    expect(html).toMatch(/<button type="button" class="ak-button">Decline all shown…<\/button>/);
    const dialog = dialogOf(html);
    expect(dialog).toContain('Decline all 50 requests shown?');
    expect(dialog).toContain('Yes, decline 50 requests');
    expect(dialog).toContain('Nobody is told');
    expect(dialog).toMatch(/<button type="button" class="ak-button">Cancel<\/button>/);
    const ids = [...dialog.matchAll(/<input type="hidden" name="id" value="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(ids).toHaveLength(50);
    expect(ids).toEqual((list(50) as Extract<AccessRequestList, { state: 'ok' }>).requests.map((r) => r.id));
    // The requesters' words aren't in the confirm step.
    expect(dialog).not.toContain('Pat');
    expect(dialog).not.toContain('evil.example');
    // A few: the count follows; one alone has its own Decline, so no bulk button.
    expect(dialogOf(render(list(3)))).toContain('Decline all 3 requests shown?');
    expect(render(list(1))).not.toContain('Decline all shown');
  });

  it('keeps each request’s own Approve and Decline, and the approve form shows the typed name as theirs, with an editable Name', () => {
    const html = render(list(2));
    expect(html).toContain('Approve: invite p0@example.org');
    expect(html).toContain('Decline (they aren’t told)');
    expect(html).toContain('They wrote: “Pat &lt;b&gt;1&lt;/b&gt;”');
    expect(html).toMatch(/<input type="text" maxLength="100" autoComplete="off" name="name" value="Pat &lt;b&gt;0&lt;\/b&gt;"\/>/);
    // No typed name: no "They wrote", and an empty Name field.
    const nameless: AccessRequestList = { state: 'ok', fetchedAt: '2026-10-18T12:00:00.000Z', truncated: false, requests: [{ id: '0001760788800000-abcdefabcdef', email: 'q@example.org', createdAt: '2026-10-18T12:00:00.000Z', expiresAt: '2026-11-17T12:00:00.000Z' }] };
    const bare = render(nameless);
    expect(bare).not.toContain('They wrote');
    expect(bare).toMatch(/<input type="text" maxLength="100" autoComplete="off" name="name" value=""\/>/);
  });
});

describe('Settings → Sign-in help (ADR 0024)', () => {
  const ok: SignInHelpSettingsView = {
    state: 'ok',
    configured: 'apps-help@agency.example.org',
    override: { address: 'help@agency.example.org', updatedAt: '2026-10-18T12:00:00.000Z', updatedBy: { sub: 's1', email: 'sa@example.org' }, reason: 'New desk' },
    effective: { address: 'help@agency.example.org', source: 'override' },
    version: 2,
  };

  it('says which address is in effect and where it came from, and offers to go back to the configured one', () => {
    const html = renderToStaticMarkup(h(SignInHelpSettings, { view: ok, actions: { set: noop, clear: noop } }));
    expect(html).toContain('<strong>help@agency.example.org</strong>');
    expect(html).toContain('(set here)');
    expect(html).toContain('by sa@example.org: “New desk”');
    expect(html).toContain('name="version" value="2"');
    expect(html).toContain('Go back to apps-help@agency.example.org');
    expect(html).toContain('The owner is told about every change.');
  });

  it('is honest when the setting couldn’t be read, and closed to people without the capability', () => {
    expect(renderToStaticMarkup(h(SignInHelpSettings, { view: { state: 'unavailable', configured: 'x@example.org', reason: 'Couldn’t read the help setting.' }, actions: { set: noop, clear: noop } }))).toContain('Couldn’t read the help setting.');
    expect(renderToStaticMarkup(h(SignInHelpSettings, { view: { state: 'forbidden', reason: 'You can’t open this setting.' }, actions: { set: noop, clear: noop } }))).toContain('You can’t open this setting.');
  });
});
