/**
 * The page the screenshot tests draw on: an empty page on a made-up origin that serves only the two
 * standalone files. Every other request is refused and recorded, and every browser API that could reach
 * outside the page is wrapped and counted before the preview loads, so a test can prove the preview
 * touched none of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { AuthKitPreviewGlobal, PreviewHandle } from '../../src/preview/standalone/index.js';

export const ORIGIN = 'http://preview.test';
const RELEASE = join(import.meta.dirname, '..', '..', 'release');
const FILES = ['auth-kit-preview.js', 'auth-kit-preview-backdrops.js'] as const;

/** A font the Playwright image has, so every run renders the same glyphs. */
export const FONT = '"Liberation Sans", Arial, sans-serif';

declare global {
  interface Window {
    AuthKitPreview: AuthKitPreviewGlobal;
    card?: PreviewHandle;
    /** Calls to browser APIs that reach outside the page, by name. */
    __touches: string[];
  }
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>preview</title>
<style>html, body { margin: 0; background: #ffffff; } #host { display: inline-block; vertical-align: top; }</style>
</head><body><div id="host"></div><script src="/auth-kit-preview.js"></script></body></html>`;

/** Runs before the preview: counts every use of an API that could leave the page. */
function watchTheExits(): void {
  const touches: string[] = [];
  window.__touches = touches;
  const wrap = <T extends object>(owner: T | undefined, key: keyof T, name: string) => {
    if (!owner) return;
    const original = owner[key] as unknown;
    if (typeof original !== 'function') return;
    Object.defineProperty(owner, key, {
      configurable: true,
      value(this: unknown, ...args: unknown[]) {
        touches.push(name);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      },
    });
  };
  wrap(window, 'fetch', 'fetch');
  wrap(window, 'open', 'window.open');
  wrap(XMLHttpRequest.prototype, 'open', 'XMLHttpRequest');
  wrap(navigator, 'sendBeacon', 'sendBeacon');
  wrap(Storage.prototype, 'setItem', 'storage.setItem');
  wrap(Storage.prototype, 'removeItem', 'storage.removeItem');
  wrap(Storage.prototype, 'clear', 'storage.clear');
  if (navigator.credentials) {
    wrap(navigator.credentials, 'get', 'credentials.get');
    wrap(navigator.credentials, 'create', 'credentials.create');
  }
  if (navigator.clipboard) wrap(navigator.clipboard, 'writeText', 'clipboard.writeText');
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookie?.set) {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => cookie.get!.call(document) as string,
      set: (value: string) => {
        touches.push('document.cookie');
        cookie.set!.call(document, value);
      },
    });
  }
}

/** Opens the harness. `requests` lists every file served and every request refused. */
export async function openHarness(page: Page): Promise<{ requests: string[]; navigations: string[]; errors: string[] }> {
  const requests: string[] = [];
  const navigations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('dialog', (dialog) => {
    errors.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('framenavigated', (frame) => navigations.push(frame.url()));
  await page.addInitScript(watchTheExits);
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    const file = FILES.find((f) => url.origin === ORIGIN && url.pathname === `/${f}`);
    if (file) {
      requests.push(file);
      return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(RELEASE, file)) });
    }
    requests.push(`REFUSED ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof window.AuthKitPreview === 'object');
  navigations.length = 0;
  return { requests, navigations, errors };
}

/** Everything a test checks after it ran: nothing left the page. */
export async function exitsUsed(page: Page): Promise<{ touches: string[]; storage: number[] }> {
  return page.evaluate(() => ({ touches: window.__touches, storage: [localStorage.length, sessionStorage.length] }));
}
