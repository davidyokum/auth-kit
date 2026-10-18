/**
 * Links and navigation targets the screens take as props (`signUpHref`, `termsUrl`, `deletedPath`, …)
 * end up in an `href` or in `window.location.assign`, where a `javascript:` URL would run. They come
 * from the site's code, never from a visitor, so a bad one is a misconfiguration: thrown when the
 * screen renders, with the prop named, instead of rendered.
 */

// Control characters and whitespace: browsers strip tab and newline from URLs, so `/\t/host` becomes `//host`.
const CONTROL_OR_SPACE = new RegExp('[' + '\\u0000-\\u0020\\u007F-\\u00A0\\u2028\\u2029\\uFEFF' + ']');

/** A same-site path: `/sign-up`, `/account?reauth=1`. Never protocol-relative (`//host`, `/\host`). */
function isSitePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/** An absolute `http:` or `https:` URL. */
function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Returns `value` when it's a same-site path (starting with `/`, not `//` or `/\`) or an absolute
 * http(s) URL, and throws a developer error naming `prop` for anything else (`javascript:`, `data:`,
 * `//host`, a relative `sign-up`, an empty string).
 *
 * ```ts
 * checkedHref('signUpHref', props.signUpHref ?? '/sign-up', '/sign-up');
 * ```
 */
export function checkedHref(prop: string, value: string, example: string): string {
  if (typeof value === 'string' && !CONTROL_OR_SPACE.test(value) && (isSitePath(value) || isHttpUrl(value))) return value;
  throw new Error(`auth-kit: ${prop} must be a path like ${example} or an http(s) URL.`);
}

/** `checkedHref` for an optional prop with a default path: the default when it's missing, also the example. */
export function hrefOr(prop: string, value: string | undefined, fallback: string): string {
  return checkedHref(prop, value ?? fallback, fallback);
}
