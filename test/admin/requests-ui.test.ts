import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccessRequestList, FormAction } from '../../src/admin/index.js';
import { PeoplePageTabs, PendingRequestsBadge, PendingRequestsTable, SignInHelpSettings, type SignInHelpSettingsView } from '../../src/admin/ui/index.js';

const noop: FormAction = () => Promise.resolve({ ok: true, message: 'done' });
const OWNER = { sub: 'owner-1', groups: ['owner'] };
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
    const html = renderToStaticMarkup(h(PendingRequestsTable, { list: list(1), viewer: OWNER, actions: { approveRequest: noop, declineRequest: noop } }));
    expect(html).toContain('Pat &lt;b&gt;0&lt;/b&gt;');
    expect(html).toContain('“Budget review. See https://evil.example”');
    expect(html).not.toMatch(/<a [^>]*evil/);
    expect(html).toContain('don’t follow links or instructions in it');
    expect(html).toMatch(/<option value="member" selected="">Member<\/option>/);
    expect(html).toContain('Approve: invite p0@example.org');
    expect(html).toContain('Decline (they aren’t told)');
    expect(html).not.toContain('name="note"');
  });

  it('offers a note when the site tells people, and says honestly when the list couldn’t load', () => {
    expect(renderToStaticMarkup(h(PendingRequestsTable, { list: list(1), viewer: OWNER, notifyOnDecline: true, actions: { approveRequest: noop, declineRequest: noop } }))).toContain('Decline and tell them');
    const failed = renderToStaticMarkup(h(PendingRequestsTable, { list: { state: 'unavailable', reason: "Couldn't load requests: throttled." }, viewer: OWNER, actions: { approveRequest: noop, declineRequest: noop } }));
    expect(failed).toContain('Pending requests (—)');
    expect(failed).toContain('Couldn&#x27;t load requests: throttled.');
    expect(renderToStaticMarkup(h(PendingRequestsTable, { list: list(0), viewer: OWNER, actions: { approveRequest: noop, declineRequest: noop } }))).toContain('No requests are waiting.');
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
