/**
 * Post-login redirects go through `safeRedirect`, which allows same-site relative paths only.
 *
 * It rejects anything a browser, framework, or CDN could turn into another origin:
 * - protocol-relative `//host` and `/\host` (browsers treat `\` as `/`), and any backslash
 * - schemes (`javascript:`, `data:`, `https:`), with or without leading junk
 * - control characters and whitespace (browsers strip tab/newline, so `/\t/host` becomes `//host`)
 * - the same tricks percent-encoded, up to three layers deep (`/%2F%2Fhost`, `/%5Chost`, `%252F`)
 * - dot segments that normalize into `//host` (`/.//host`, `/..//host`)
 *
 * It returns the normalized path (`pathname + search + hash`), or the fallback.
 */

export interface SafeRedirectOptions {
  /** Only allow these path prefixes, e.g. `['/dashboard', '/admin']`. */
  allowedPrefixes?: readonly string[];
  /** Longest accepted input. Default 2048. */
  maxLength?: number;
}

const BASE = 'https://safe-redirect.invalid';
// Control characters plus ASCII and Unicode whitespace.
const CONTROL_OR_SPACE = new RegExp('[' + '\\u0000-\\u0020\\u007F-\\u00A0\\u1680\\u180E\\u2000-\\u200F\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF' + ']');
// Characters browsers drop while parsing a URL (tab, LF, CR) or that end a header value.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const STRIPPED_BY_PARSERS = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex -- leading control characters before a scheme
const SCHEME = /^[\s\u0000-\u001F]*[a-z][a-z0-9+.-]*:/i;

function decodeLayers(value: string, depth = 3): string[] {
  const layers = [value];
  let current = value;
  for (let i = 0; i < depth; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    layers.push(next);
    current = next;
  }
  return layers;
}

function structurallyUnsafe(path: string): boolean {
  return (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    SCHEME.test(path) ||
    STRIPPED_BY_PARSERS.test(path)
  );
}

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const p = prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
    return p === '/' || pathname === p || pathname.startsWith(`${p}/`);
  });
}

function check(target: unknown, options: SafeRedirectOptions): string | null {
  if (typeof target !== 'string') return null;
  const maxLength = options.maxLength ?? 2048;
  if (target.length === 0 || target.length > maxLength) return null;
  // The raw value: a plain path with no whitespace or control characters at all.
  if (CONTROL_OR_SPACE.test(target) || structurallyUnsafe(target)) return null;
  // Every decoded layer must still be a plain same-site path.
  for (const layer of decodeLayers(target).slice(1)) {
    if (structurallyUnsafe(layer)) return null;
  }
  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const result = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalize into a protocol-relative path.
  if (!result.startsWith('/') || result.startsWith('//') || result.includes('\\')) return null;
  if (options.allowedPrefixes && !matchesPrefix(url.pathname, options.allowedPrefixes)) return null;
  return result;
}

/** True when `target` is a safe same-site path. */
export function isSafeRedirect(target: unknown, options: SafeRedirectOptions = {}): boolean {
  return check(target, options) !== null;
}

/**
 * Returns `target` as a normalized same-site path if it's safe, otherwise `fallback` (itself checked,
 * falling back to `/`).
 *
 * ```ts
 * redirect(safeRedirect(searchParams.get('next'), '/dashboard'));
 * ```
 */
export function safeRedirect(target: unknown, fallback = '/', options: SafeRedirectOptions = {}): string {
  return check(target, options) ?? check(fallback, {}) ?? '/';
}
