import { nonceCspHeaders, withAuthProxy } from 'auth-kit/proxy';
import { auth } from './lib/auth.js';

const dev = process.env.NODE_ENV === 'development';

export const proxy = withAuthProxy({
  auth,
  publicRoutes: ['/', '/unavailable'],
  headers: nonceCspHeaders(
    (nonce) =>
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}; ` +
      "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  ),
});

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
