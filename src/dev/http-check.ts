/**
 * The HTTP half of the production check: against a running production build (`next start`), the
 * dev route must answer 404 even to requests forged to pass every gate (Host: localhost, a matching
 * Origin, JSON). Uses `node:http` because `fetch` won't let a caller set the Host header.
 *
 * A 401 or a redirect means the auth proxy answered before routing, which proves nothing about the
 * route; list the dev route among the proxy's public routes so a build without it answers 404.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER, DEV_SIGNIN_MARKER_HEADER } from './marker.js';

export interface DevRouteCheckOptions {
  /** The running production server, e.g. `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** Default `/api/dev/sign-in`. */
  route?: string;
  /** Per request. Default 10 seconds. */
  timeoutMs?: number;
}

export interface DevRouteProbe {
  method: string;
  host: string;
  status: number | null;
  ok: boolean;
  problem?: string;
}

export interface DevRouteCheckResult {
  ok: boolean;
  probes: DevRouteProbe[];
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<RawResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method,
        headers: { ...headers, ...(body !== undefined && { 'content-length': String(Buffer.byteLength(body)) }) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 64_000) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Sends forged requests to the dev route; passes only if every one gets a plain 404. */
export async function checkDevRouteAbsent(options: DevRouteCheckOptions): Promise<DevRouteCheckResult> {
  const base = new URL(options.baseUrl);
  const route = options.route ?? DEV_SIGN_IN_ROUTE;
  const url = new URL(route, base);
  const port = base.port ? `:${base.port}` : '';
  const hosts = [...new Set([`localhost${port}`, `app.localhost${port}`, `127.0.0.1${port}`, `[::1]${port}`, base.host])];
  const probes: DevRouteProbe[] = [];

  const variants: { method: string; host: string; body?: string }[] = [
    ...hosts.map((host) => ({ method: 'POST', host, body: JSON.stringify({ persona: 'admin' }) })),
    { method: 'GET', host: `localhost${port}` },
    { method: 'DELETE', host: `localhost${port}` },
  ];

  for (const v of variants) {
    const origin = `${base.protocol}//${v.host}`;
    const headers: Record<string, string> = {
      host: v.host,
      origin,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': v.host,
      accept: 'application/json',
      ...(v.body !== undefined && { 'content-type': 'application/json' }),
    };
    try {
      const res = await send(url, v.method, headers, v.body, options.timeoutMs ?? 10_000);
      const marked = res.headers[DEV_SIGNIN_MARKER_HEADER] !== undefined || res.body.includes(DEV_SIGNIN_MARKER);
      let problem: string | undefined;
      if (marked) problem = 'the response carries the dev sign-in marker: the route is in this build';
      else if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        problem = `got ${res.status}: the auth proxy answered before routing. Add '${route}' to the proxy's publicRoutes so a build without the route answers 404`;
      } else if (res.status !== 404) problem = `got ${res.status}, not 404`;
      probes.push({ method: v.method, host: v.host, status: res.status, ok: problem === undefined, ...(problem !== undefined && { problem }) });
    } catch (error) {
      probes.push({ method: v.method, host: v.host, status: null, ok: false, problem: `request failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { ok: probes.every((p) => p.ok), probes };
}
