/**
 * Tests make no calls beyond this machine. `AWS_BLOCKED_ENV` stops the AWS SDK at credential lookup,
 * but that only covers operations that sign requests: about 30 of Cognito's user APIs take only an
 * access token (`GetUser`, `GetUserAuthFactors`, `ChangePassword`, `VerifyUserAttribute`, …), skip
 * credential lookup, and would reach Cognito's public endpoint if a test forgot a mock. Amplify's
 * client posts the same APIs with `fetch`.
 *
 * So every test file starts with two guards that refuse any host but this machine's, before a
 * connection is opened:
 * - `fetch` (a test that stubs `fetch` itself replaces this for its own run);
 * - `net.Socket.prototype.connect`, under every HTTP client: the AWS SDK's `https.request`, undici's
 *   `fetch`, and anything else that opens a TCP or TLS connection. Local sockets and IPC pipes pass.
 *
 * test/package/no-aws.test.ts is the canary.
 */
import net from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || h.startsWith('127.');
}

const refusal = (where: string) => `auth-kit tests make no network calls beyond this machine (${where}). Mock this request.`;

// ---- fetch -----------------------------------------------------------------------------------------

const realFetch = globalThis.fetch.bind(globalThis);

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // A relative URL resolves against the page (jsdom) or this machine.
  return new URL(raw, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/');
}

const guardedFetch: typeof fetch = (input, init) => {
  const url = urlOf(input);
  if (!isLocalHost(url.hostname)) return Promise.reject(new TypeError(refusal(`${url.protocol}//${url.host}`)));
  return realFetch(input, init);
};

globalThis.fetch = guardedFetch;

// ---- sockets ---------------------------------------------------------------------------------------

/** The host a `socket.connect(…)` call targets, or undefined for a local pipe or IPC path. */
function connectHost(args: unknown[]): string | undefined {
  const [first, second] = args;
  if (Array.isArray(first)) return connectHost(first as unknown[]); // Node's internal normalized form
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; host?: unknown; hostname?: unknown };
    if (typeof options.path === 'string') return undefined;
    const host = options.host ?? options.hostname;
    return typeof host === 'string' && host !== '' ? host : 'localhost';
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) return typeof second === 'string' && second !== '' ? second : 'localhost';
  if (typeof first === 'string') return undefined; // a pipe path
  return 'localhost';
}

// Called with the socket as `this` below, as Node calls it.
// eslint-disable-next-line @typescript-eslint/unbound-method
const realConnect = net.Socket.prototype.connect;
function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
  const host = connectHost(args);
  if (host !== undefined && !isLocalHost(host)) {
    const error = Object.assign(new Error(refusal(host)), { code: 'AUTH_KIT_NO_NETWORK' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
}
net.Socket.prototype.connect = guardedConnect;
