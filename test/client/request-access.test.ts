// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestAccess, type RequestAccessProps, SignedOutEverywhere } from '../../src/client/index.js';

function answer(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function setup(props: Partial<RequestAccessProps> = {}) {
  const navigate = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(() => answer({ ok: true }));
  const user = userEvent.setup();
  render(createElement(RequestAccess, { siteName: 'Example Reports', help: { address: 'apps-help@example.org' }, navigate, fetch, ...props }));
  return { navigate, fetch, user };
}

const root = () => document.querySelector<HTMLElement>('[data-auth-kit="request-access"]')!;
const inlineError = (field: HTMLElement) => document.getElementById(`${field.id}-error`)?.textContent ?? null;
const nameField = () => screen.getByLabelText<HTMLInputElement>('Name');
const emailField = () => screen.getByLabelText<HTMLInputElement>('Email address');
const reasonField = () => screen.getByLabelText<HTMLTextAreaElement>('What do you need it for? (optional)');

// No network from tests: the form's own `fetch` is injected; anything reaching the real one fails loudly.
const noNetwork = vi.fn((input: unknown) => Promise.reject(new Error(`test reached the network: ${String(input)}`)));

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
});

describe('RequestAccess', () => {
  it('asks for a name, an email, and an optional reason', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Request access to Example Reports', level: 1 })).toBeTruthy();
    expect(screen.getByText('The Example Reports team reviews requests. If they approve, you’ll get an email invitation.')).toBeTruthy();
    expect(nameField().getAttribute('autocomplete')).toBe('name');
    expect(emailField().getAttribute('autocomplete')).toBe('email');
    expect(emailField().getAttribute('placeholder')).toBe('name@example.com');
    expect(reasonField().getAttribute('maxlength')).toBe('500');
    expect(screen.getByRole('button', { name: 'Send request' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy();
  });

  it('a named family says who reviews, and uses the family’s example', () => {
    setup({ theme: 'osbm', help: { address: 'apps-help@example.org', owner: 'Jordan Lee' } });
    expect(screen.getByText('Jordan Lee reviews requests. If they approve, you’ll get an email invitation.')).toBeTruthy();
    expect(emailField().getAttribute('placeholder')).toBe('name@osbm.nc.gov');
    expect(root().querySelector('[data-auth-kit-slot="footer"]')!.textContent).toBe('This site is managed by the NC Office of State Budget and Management');
  });

  it('an empty form: both problems in the summary (each linking to its field) and by each field, and nothing posted', async () => {
    const { user, fetch } = setup();
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    const alert = screen.getByRole('alert');
    expect([...alert.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Enter your name', 'Enter your email address']);
    expect(document.activeElement).toBe(alert);
    expect(within(alert).getByRole('link', { name: 'Enter your name' }).getAttribute('href')).toBe(`#${nameField().id}`);
    expect(within(alert).getByRole('link', { name: 'Enter your email address' }).getAttribute('href')).toBe(`#${emailField().id}`);
    expect(inlineError(nameField())).toBe('Error: Enter your name');
    expect(inlineError(emailField())).toBe('Error: Enter your email address');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(emailField().getAttribute('aria-invalid')).toBe('true');
    expect(reasonField().hasAttribute('aria-invalid')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole('link', { name: 'Enter your email address' }));
    expect(document.activeElement).toBe(emailField());
  });

  it('a malformed address names the example', async () => {
    const { user, fetch } = setup({ emailHint: 'name@example.org' });
    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Enter an email address like name@example.org');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefills an address handed over from the sign-up screen, once', () => {
    window.sessionStorage.setItem('auth-kit:request-access-email', 'ada@elsewhere.example');
    setup();
    expect(emailField().value).toBe('ada@elsewhere.example');
    expect(window.sessionStorage.getItem('auth-kit:request-access-email')).toBeNull();
  });

  it('posts { name, email, reason } and says "Request sent"', async () => {
    const { user, fetch, navigate } = setup();
    await user.type(nameField(), ' Ada Lovelace ');
    await user.type(emailField(), 'ada@example.org');
    await user.type(reasonField(), 'Quarterly reports ');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/request-access');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Ada Lovelace', email: 'ada@example.org', reason: 'Quarterly reports' });
    expect(screen.getByText('Thanks. If an admin approves, you’ll get an email invitation. If you already have an account, just sign in.')).toBeTruthy();
    expect(root().getAttribute('data-auth-kit-view')).toBe('sent');
    expect(screen.getAllByRole('button', { name: 'Back to sign in' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(navigate).toHaveBeenCalledWith('/sign-in');
  });

  it('leaves the reason out when it’s empty, and uses a site’s own endpoint and sign-in link', async () => {
    const { user, fetch, navigate } = setup({ endpoint: '/api/ask', signInHref: '/login' });
    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.org{Enter}');
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/ask');
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({ name: 'Ada Lovelace', email: 'ada@example.org' });
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('a server error about a field lands on that field', async () => {
    const { user, fetch } = setup();
    fetch.mockImplementation(() => answer({ ok: false, code: 'invalid', error: 'Keep it to 500 characters', field: 'reason' }, 400));
    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.org');
    await user.type(reasonField(), 'Reports');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Keep it to 500 characters' }).getAttribute('href')).toBe(`#${reasonField().id}`);
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(inlineError(reasonField())).toBe('Error: Keep it to 500 characters');
    expect(reasonField().getAttribute('aria-describedby')).toBe(`${reasonField().id}-error`);
    expect(screen.queryByRole('heading', { name: 'Request sent' })).toBeNull();

    fetch.mockImplementation(() => answer({ ok: false, code: 'not_available', error: 'Use a different email address', field: 'email' }, 400));
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(inlineError(emailField())).toBe('Error: Use a different email address'));
    expect(reasonField().hasAttribute('aria-invalid')).toBe(false);
  });

  it('a server error without a field, or no answer at all, goes in the summary', async () => {
    const { user, fetch } = setup();
    fetch.mockImplementation(() => answer({ ok: false, code: 'rate_limited', error: 'Too many attempts from this network. Wait 5 minutes, then try again.' }, 429));
    await user.type(nameField(), 'Ada Lovelace');
    await user.type(emailField(), 'ada@example.org{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many attempts from this network. Wait 5 minutes, then try again.'));
    expect(nameField().hasAttribute('aria-invalid')).toBe(false);
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('We couldn’t reach the sign-in service. Check your connection and try again. If it keeps happening, email apps-help@example.org.'),
    );
  });

  it('shows the privacy line only with a privacy notice', () => {
    setup();
    expect(screen.queryByText(/We use this only to decide on your request/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Privacy notice' })).toBeNull();
    cleanup();
    setup({ privacyNoticeUrl: '/privacy' });
    const link = screen.getByRole('link', { name: 'Privacy notice' });
    expect(link.getAttribute('href')).toBe('/privacy');
    expect(link.parentElement!.textContent).toBe('We use this only to decide on your request. Privacy notice');
  });
});

describe('SignedOutEverywhere', () => {
  it('says so, and links to sign in again', () => {
    render(createElement(SignedOutEverywhere, { siteName: 'Example Reports' }));
    expect(screen.getByRole('heading', { name: 'You’re signed out everywhere', level: 1 })).toBeTruthy();
    expect(screen.getByText('You’ve been signed out of Example Reports on all your devices.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Sign in again' });
    expect(link.getAttribute('href')).toBe('/sign-in');
    expect(link.getAttribute('data-auth-kit-slot')).toBe('button');
    const root = document.querySelector('[data-auth-kit="signed-out"]')!;
    expect(root.querySelector('[data-backdrop-card]')).not.toBeNull();
    expect(root.querySelector('[data-auth-kit-slot="footer"]')).toBeNull();
  });

  it('takes a sign-in link, a heading level, and the family', () => {
    render(createElement(SignedOutEverywhere, { siteName: 'Example Reports', signInHref: '/login', headingLevel: 2, theme: 'unc' }));
    expect(screen.getByRole('heading', { name: 'You’re signed out everywhere', level: 2 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/login');
    expect(document.querySelector('[data-auth-kit-slot="footer"]')!.textContent).toBe('This site is managed by UNC-Chapel Hill');
  });
});
