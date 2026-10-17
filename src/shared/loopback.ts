/**
 * Loopback host checks shared by the proxy's matrix handler pass and the local-development cookie
 * option. No imports, so any module can use it.
 */

/** True for `localhost`, `*.localhost`, `127.x.x.x`, and `[::1]` / `::1` (a host name, no port). */
export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const name = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (name === '[::1]' || name === '::1') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(name)) return true;
  if (name !== 'localhost' && !name.endsWith('.localhost')) return false;
  return name.split('.').every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

/** True for an `http:` origin (no path) on a loopback host, e.g. `http://app.localhost:3000`. */
export function isPlainHttpLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && url.origin === origin && isLoopbackHostname(url.hostname);
}
