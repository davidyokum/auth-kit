/**
 * Tests make no calls beyond this machine. `AWS_BLOCKED_ENV` stops the AWS SDK at credential lookup,
 * but some of Cognito's user APIs (ChangePassword, for one) take only an access token, and Amplify's
 * client posts them with `fetch`: a test that forgets a mock would reach Cognito's public endpoint.
 * So every test file starts with a `fetch` that refuses any host but this machine's, before a request
 * is made. A test that stubs `fetch` itself replaces this for its own run.
 *
 * test/package/no-aws.test.ts is the canary.
 */
const realFetch = globalThis.fetch.bind(globalThis);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // A relative URL resolves against the page (jsdom) or this machine.
  return new URL(raw, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/');
}

export function isLocalUrl(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

const guardedFetch: typeof fetch = (input, init) => {
  const url = urlOf(input);
  if (!isLocalUrl(url)) {
    return Promise.reject(new TypeError(`auth-kit tests make no network calls beyond this machine (${url.protocol}//${url.host}). Mock this request.`));
  }
  return realFetch(input, init);
};

globalThis.fetch = guardedFetch;
