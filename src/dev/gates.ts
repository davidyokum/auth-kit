/**
 * The gates in front of "Sign in as…" (primer Chapter 8, Figure 8.2).
 *
 * Every gate asks where the code runs, never who is calling, and one gate alone fails silently when
 * a deploy is misconfigured. So all of them must pass, the route also checks that the pool is a
 * sandbox (see `sandbox.ts`), the code is left out of production builds, and CI proves it.
 */

export type DevGateId = 'nodeEnv' | 'host' | 'flag' | 'proxy';

export interface DevGate {
  id: DevGateId;
  label: string;
  check: string;
  /** What this gate alone stops, and what it can't. */
  failsWhen: string;
}

export const DEV_GATES: readonly DevGate[] = [
  {
    id: 'nodeEnv',
    label: 'Development mode',
    check: "process.env.NODE_ENV === 'development'",
    failsWhen: 'Every deployed build: next build sets NODE_ENV to production',
  },
  {
    id: 'host',
    label: 'A loopback host name',
    check: 'Host, the URL, and any X-Forwarded-Host are localhost, *.localhost, 127.0.0.1, or [::1]',
    failsWhen:
      'Every deployed host, and DNS rebinding (the browser sends the attacker’s name). Never enough alone: the sender writes the Host header, hence binding the dev server to 127.0.0.1',
  },
  {
    id: 'flag',
    label: 'An explicit flag',
    check: "process.env.ALLOW_DEV_SIGNIN === '1'",
    failsWhen: "Wherever the flag isn't set; a flag copied into a branch's settings ships with it",
  },
  {
    id: 'proxy',
    label: 'Not forwarded from elsewhere',
    check: 'Every client address in X-Forwarded-For, Forwarded, X-Real-IP, and similar headers is loopback',
    failsWhen:
      'A tunnel (ngrok, cloudflared) or proxy in front of next dev, which connects from 127.0.0.1 but names the real client. A caller who forges these headers gets past it, so it backs up the loopback binding, never replaces it',
  },
];

export interface DevGateInput {
  nodeEnv: string | undefined;
  /** The request's Host header. */
  host: string | null | undefined;
  /** `process.env.ALLOW_DEV_SIGNIN`. */
  flag: string | undefined;
  /** Other names the request carries (the URL's host, X-Forwarded-Host). Each must be loopback too. */
  otherHosts?: readonly (string | null | undefined)[];
  /** Client addresses named by proxy headers. Each must be loopback. */
  clientAddresses?: readonly string[];
}

export interface DevGateResult {
  allowed: boolean;
  failed: DevGateId[];
}

function validPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}

/** True for `localhost` or `*.localhost` (each label a valid DNS label), with or without a port. */
export function isLocalhostName(host: string | null | undefined): boolean {
  if (!host) return false;
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m?.[1] || !validPort(m[2])) return false;
  const name = m[1].toLowerCase().replace(/\.$/, '');
  if (name !== 'localhost' && !name.endsWith('.localhost')) return false;
  // Each label must be a valid DNS label (no empty labels like "a..localhost").
  return name.split('.').every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

/**
 * True for a host that can only mean this computer: `localhost`, `*.localhost`, `127.0.0.1`, or
 * `[::1]`, with an optional port. Anything else, including `localhost.example.org`, `127.0.0.2`,
 * unbracketed `::1`, and non-canonical spellings of the loopback addresses, is false.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m?.[1] || !validPort(m[2])) return false;
  const name = m[1].toLowerCase();
  if (name === '127.0.0.1' || name === '[::1]') return true;
  return isLocalhostName(name);
}

/** True for a loopback IP address (127.0.0.0/8, ::1, or ::ffff:127.x.x.x), with an optional port. */
export function isLoopbackAddress(address: string): boolean {
  let a = address.trim().toLowerCase();
  if (a.length >= 2 && a.startsWith('"') && a.endsWith('"')) a = a.slice(1, -1);
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(a);
  if (bracketed?.[1]) a = bracketed[1];
  else {
    const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(a);
    if (v4WithPort?.[1]) a = v4WithPort[1];
  }
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped?.[1]) a = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return v4 !== null && v4[1] === '127' && v4.slice(1).every((octet) => Number(octet) <= 255);
}

/** Headers in which proxies and tunnels name the real client. */
export const CLIENT_ADDRESS_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'fastly-client-ip',
] as const;

/** Every client address named by proxy headers, including RFC 7239 `Forwarded: for=…`. */
export function forwardedClientAddresses(headers: { get(name: string): string | null }): string[] {
  const out: string[] = [];
  for (const name of CLIENT_ADDRESS_HEADERS) {
    const value = headers.get(name);
    if (value) out.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const forwarded = headers.get('forwarded');
  if (forwarded) {
    for (const element of forwarded.split(',')) {
      for (const pair of element.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq).trim().toLowerCase() === 'for') out.push(pair.slice(eq + 1).trim());
      }
    }
  }
  return out;
}

/** Checks every gate. "Sign in as…" answers 404 unless `allowed` is true. */
export function checkDevSignInGates(input: DevGateInput): DevGateResult {
  const failed: DevGateId[] = [];
  if (input.nodeEnv !== 'development') failed.push('nodeEnv');
  const hosts = [input.host, ...(input.otherHosts ?? [])];
  // `null`/`undefined` in otherHosts means "not sent" (fine); the Host header itself is required.
  if (!isLoopbackHost(input.host) || hosts.slice(1).some((h) => h != null && !isLoopbackHost(h))) failed.push('host');
  if (input.flag !== '1') failed.push('flag');
  if ((input.clientAddresses ?? []).some((a) => !isLoopbackAddress(a))) failed.push('proxy');
  return { allowed: failed.length === 0, failed };
}

/** The request facts the gates read. */
export function devGateInputFor(
  request: { url?: string; headers: { get(name: string): string | null } },
  env: { NODE_ENV?: string; ALLOW_DEV_SIGNIN?: string } = process.env,
): DevGateInput {
  let urlHost: string | null = null;
  if (request.url !== undefined) {
    try {
      urlHost = new URL(request.url).host;
    } catch {
      urlHost = 'invalid url';
    }
  }
  const forwardedHost = request.headers.get('x-forwarded-host');
  return {
    nodeEnv: env.NODE_ENV,
    host: request.headers.get('host'),
    flag: env.ALLOW_DEV_SIGNIN,
    otherHosts: [urlHost, ...(forwardedHost ? forwardedHost.split(',').map((s) => s.trim()) : [])],
    clientAddresses: forwardedClientAddresses(request.headers),
  };
}

/** The gates for the current process and a request. */
export function devSignInGatesFor(request: { url?: string; headers: { get(name: string): string | null } }): DevGateResult {
  return checkDevSignInGates(devGateInputFor(request));
}

// ---- The dev server ------------------------------------------------------------------------------

/** The dev server command: listen on loopback only, so the café Wi-Fi can't reach it at all. */
export const DEV_SERVER_COMMAND = 'next dev --hostname 127.0.0.1';

export interface LocalDevServer {
  /** For package.json: `"dev": "<command>"`. */
  command: string;
  /** Where to open the app. Chrome sends every `*.localhost` name to this computer. */
  url: string;
}

/**
 * The dev command and URL for one app: loopback-only, its own port, and its own `*.localhost` name,
 * because cookies ignore ports (apps on `localhost:3000` and `:3001` share every cookie).
 *
 * ```ts
 * localDevServer({ app: 'reports', port: 3000 });
 * // { command: 'next dev --hostname 127.0.0.1 --port 3000', url: 'http://reports.localhost:3000' }
 * ```
 */
export function localDevServer(input: { app: string; port?: number }): LocalDevServer {
  const port = input.port ?? 3000;
  const name = input.app.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name)) {
    throw new Error(`auth-kit: "${input.app}" can't be used as the <app> in <app>.localhost.`);
  }
  if (!validPort(String(port))) throw new Error(`auth-kit: port ${port} is out of range.`);
  return { command: `${DEV_SERVER_COMMAND} --port ${port}`, url: `http://${name}.localhost:${port}` };
}
