/**
 * #7: TOTPEnrollmentGate must never mask the server's answer. Wrapped around a layout's children, an
 * earlier version rendered only "Checking your account…" on the server, so a nested page's
 * `notFound()` never ran during server rendering and its 404 went out as 200. These render the gate
 * with React's server renderer, the way Next does, and check the children's errors still surface.
 */
import { createElement, lazy, type ReactNode } from 'react';
import { renderToReadableStream, renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TOTPEnrollmentGate } from '../../src/client/index.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

const never = () => new Promise<never>(() => undefined);
const gate = (children: ReactNode, extra: Record<string, unknown> = {}) =>
  createElement(TOTPEnrollmentGate, { issuer: 'Example Reports', loadFactors: never, ...extra }, children);

/** What Next's `notFound()` throws: an error whose digest Next turns into the 404 response. */
function notFoundError(): Error {
  return Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
}

function Thrower(): ReactNode {
  throw notFoundError();
}

/** Next hands a layout its page as a lazily resolved chunk; a page that calls notFound() rejects it. */
const RejectedPage = lazy(() => Promise.reject(notFoundError()));

async function html(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe('TOTPEnrollmentGate on the server', () => {
  it.each([[{}], [{ serverChecked: true }]])('renders its children during server rendering (%o)', async (extra) => {
    const out = await html(gate(createElement('p', null, 'Member’s report'), extra));
    expect(out).toContain('Member’s report');
  });

  it('hides them until the browser check passes, with a status, by default', () => {
    const out = renderToString(gate(createElement('p', null, 'Member’s report')));
    expect(out).toMatch(/<div data-auth-kit-slot="content" hidden="">\s*<p>Member’s report<\/p>/);
    expect(out).toContain('Checking your account…');
  });

  it('shows them from the first paint with serverChecked', () => {
    const out = renderToString(gate(createElement('p', null, 'Member’s report'), { serverChecked: true }));
    expect(out).toMatch(/<div data-auth-kit-slot="content">\s*<p>Member’s report<\/p>/);
    expect(out).not.toContain('Checking your account…');
  });

  it.each([[{}], [{ serverChecked: true }]])("lets a child's notFound() surface, so the 404 isn't masked as 200 (%o)", async (extra) => {
    expect(() => renderToString(gate(createElement(Thrower), extra))).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    // The streaming renderer Next uses: the shell fails, which Next answers with the 404.
    await expect(renderToReadableStream(gate(createElement(RejectedPage), extra))).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });

  it('does the same for a page nested in a layout the gate wraps', async () => {
    const layout = (children: ReactNode) => createElement('main', null, gate(createElement('section', null, children)));
    await expect(renderToReadableStream(layout(createElement(RejectedPage)))).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('(control) a wrapper that skips its children on the server would have swallowed it', async () => {
    const skipsChildren = (_: { children: ReactNode }) => createElement('div', null, 'Checking your account…');
    const out = await html(createElement(skipsChildren, null, createElement(RejectedPage)));
    expect(out).toContain('Checking your account…');
  });
});
