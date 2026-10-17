/**
 * The loopback check: refuses "Sign in as…" unless the dev server is unreachable from other
 * computers.
 *
 * The request gates (development mode, a loopback Host, the flag) all pass for a stranger on the
 * café Wi-Fi who sends `Host: localhost` to a dev server listening on every network, which is what
 * `next dev` does by default. Headers can't prove where a request came from (Next fills in
 * X-Forwarded-For only when the caller didn't), so this checks the server itself:
 *
 * 1. **Listening sockets.** `next dev` serves requests in the process that listens, so the route
 *    can see the server's own sockets. Every one must be on a loopback address (127.0.0.1, ::1);
 *    `0.0.0.0`, `::`, or a network address fails.
 * 2. **A probe**, only if no listening socket is visible: connect to this computer's network
 *    addresses on the dev port (`PORT`, which Next sets). Any answer, or no clear refusal, fails.
 * 3. Otherwise it fails: unable to tell counts as exposed.
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isLoopbackAddress } from './gates.js';

export type BindCheck = { ok: true; detail: string } | { ok: false; reason: string };

export interface ListeningSocket {
  address: string;
  port: number;
}

type HandleLike = { listening?: unknown; address?: unknown };

function activeHandles(): unknown[] | undefined {
  // Undocumented but stable since Node 0.x; the documented getActiveResourcesInfo() omits addresses.
  const fn = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  return typeof fn === 'function' ? fn.call(process) : undefined;
}

/** The TCP sockets this process listens on (net/http/https servers). Unix sockets are skipped. */
export function listeningSockets(handles: readonly unknown[] = activeHandles() ?? []): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const h of handles) {
    const handle = h as HandleLike | null;
    if (!handle || typeof handle !== 'object' || handle.listening !== true || typeof handle.address !== 'function') continue;
    let addr: unknown;
    try {
      addr = (handle.address as () => unknown).call(handle);
    } catch {
      continue;
    }
    if (addr && typeof addr === 'object' && typeof (addr as ListeningSocket).address === 'string') {
      out.push({ address: (addr as ListeningSocket).address, port: Number((addr as ListeningSocket).port) });
    }
  }
  return out;
}

/** This computer's non-loopback addresses (IPv4 and global IPv6). */
export function networkAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv6' && /^fe80:/i.test(info.address)) continue; // link-local needs a scope
      out.push(info.address);
    }
  }
  return out;
}

export type ProbeResult = 'open' | 'closed' | 'unknown';

/** Tries a TCP connection: `open` if something accepts, `closed` on a clear refusal, else `unknown`. */
export function probeTcp(host: string, port: number, timeoutMs = 500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('unknown'));
    socket.once('connect', () => done('open'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code ?? '') ? 'closed' : 'unknown');
    });
  });
}

function format(socket: ListeningSocket): string {
  return `${socket.address.includes(':') ? `[${socket.address}]` : socket.address}:${socket.port}`;
}

export interface BindCheckOptions {
  /** Default: this process's active handles. */
  handles?: () => readonly unknown[] | undefined;
  /** Default: this computer's network addresses. */
  addresses?: () => string[];
  probe?: (host: string, port: number) => Promise<ProbeResult>;
  /** The dev server's port for the probe. Default `process.env.PORT` (Next sets it). */
  port?: string | number;
}

const FIX = 'Start it with `next dev --hostname 127.0.0.1`.';

/** Passes only when the dev server can't be reached from another computer. */
export async function checkLoopbackBinding(options: BindCheckOptions = {}): Promise<BindCheck> {
  const handles = options.handles ? options.handles() : activeHandles();
  const sockets = listeningSockets(handles ?? []);
  if (sockets.length > 0) {
    const exposed = sockets.find((s) => !isLoopbackAddress(s.address));
    if (exposed) return { ok: false, reason: `the dev server listens on ${format(exposed)}, which other computers can reach. ${FIX}` };
    return { ok: true, detail: `listening on ${sockets.map(format).join(', ')} only` };
  }

  const port = Number(options.port ?? process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: `couldn't see which addresses the dev server listens on. ${FIX}` };
  }
  const probe = options.probe ?? probeTcp;
  const addresses = (options.addresses ?? networkAddresses)();
  for (const host of addresses) {
    const result = await probe(host, port);
    if (result === 'open') return { ok: false, reason: `the dev server answers on ${format({ address: host, port })}. ${FIX}` };
    if (result === 'unknown') return { ok: false, reason: `couldn't confirm port ${port} is closed on ${host}. ${FIX}` };
  }
  return { ok: true, detail: `port ${port} is closed on all ${addresses.length} network addresses` };
}
