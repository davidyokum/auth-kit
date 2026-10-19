/**
 * `auth-kit-preview.js`: preview mode for a page with no build step (ADR 0025). One classic script, with
 * React and ReactDOM inside, that sets `window.AuthKitPreview`. Built by `scripts/build-preview.mjs` and
 * attached to each GitHub Release (never in the npm package).
 *
 * ```html
 * <div id="card"></div>
 * <script src="auth-kit-preview.js"></script>
 * <script>
 *   const card = AuthKitPreview.render(document.getElementById('card'), { screen: 'choose', family: 'osbm' });
 *   card.update({ screen: 'password', state: 'wrong', family: 'osbm' });
 * </script>
 * ```
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { BACKDROP_STYLES, backdropStyle, offeredStyles } from '../../backdrops/styles/registry.js';
import { CARD_STYLES, THEME_FAMILIES } from '../../themes/index.js';
import { previewBackdrop, type PreviewBackdropHandle, type PreviewBackdropOptions } from '../backdrop.js';
import { AuthKitPreview } from '../Preview.js';
import { nextAfter, PREVIEW_ACTIONS, PREVIEW_SCREENS, resolvePreviewSpec } from '../screens.js';
import { PREVIEW_CARD_WIDTH, type PreviewSpec, type ResolvedPreviewSpec } from '../spec.js';
import { ensurePreviewStyles, PREVIEW_STYLESHEET } from '../styles.js';
import { backdropsUrl, setBackdropsUrl } from './style-loader.js';

declare const __AUTH_KIT_VERSION__: string;

/** A box in CSS pixels, relative to another element. */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewHandle {
  /** The stage: the box the card is drawn in (desktop: the card plus room around it; phone: a 375px screen). */
  readonly el: HTMLElement;
  /** The card itself (`[data-backdrop-card]`). */
  readonly card: HTMLElement;
  /** The spec as drawn: every default filled in, the state resolved. */
  readonly spec: Omit<ResolvedPreviewSpec, 'authTheme'>;
  /** The page color behind the card (the family's page, or its ink on a dark page). */
  readonly ground: string;
  /** The screen's heading, as drawn. */
  readonly heading: string;
  /** The card's box relative to `within` (default: the host). */
  rect(within?: Element): PreviewRect;
  /** Draws another spec in the same place (a whole spec: what it leaves out takes its default). */
  update(spec: PreviewSpec): void;
  /** Every control on the screen: its action's name, its words, and where the live card goes next. */
  actions(): { name: string; label: string; next: ReturnType<typeof nextAfter> }[];
  /** Moves focus as the live card does when a screen opens: to the error summary when there is one, else the heading. */
  focus(): void;
  destroy(): void;
}

let roots = 0;

function render(host: Element, spec: PreviewSpec = {}): PreviewHandle {
  if (!(host instanceof Element)) throw new TypeError('AuthKitPreview.render(host, spec): host must be an element.');
  // Checked before anything is mounted, so a bad spec throws here with a clear message.
  let resolved = resolvePreviewSpec(spec);
  ensurePreviewStyles(host);
  const container = host.ownerDocument.createElement('div');
  container.setAttribute('data-auth-kit-preview-root', '');
  container.style.display = 'contents';
  host.appendChild(container);
  // Each card its own ID prefix, so labels and fields pair up with many cards on one page.
  const root = createRoot(container, { identifierPrefix: `akp${++roots}-` });
  let current = spec;
  let destroyed = false;
  const draw = () => flushSync(() => root.render(<AuthKitPreview spec={current} injectStyles={false} />));
  draw();

  const stage = () => {
    const el = container.firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error('AuthKitPreview: this preview was destroyed.');
    return el;
  };
  const card = () => stage().querySelector<HTMLElement>('[data-backdrop-card]')!;
  const label = (el: Element) => {
    const target = el.tagName === 'FORM' ? (el.querySelector('button[type="submit"]') ?? el) : el;
    return (target.getAttribute('aria-label') ?? target.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  return {
    get el() {
      return stage();
    },
    get card() {
      return card();
    },
    get spec() {
      const { authTheme: _theme, ...rest } = resolved;
      return rest;
    },
    get ground() {
      return resolved.groundColor;
    },
    get heading() {
      return stage().querySelector('[data-auth-kit-slot="heading"]')?.textContent?.trim() ?? '';
    },
    rect(within: Element = host) {
      const a = card().getBoundingClientRect();
      const b = within.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
    },
    update(next: PreviewSpec) {
      if (destroyed) throw new Error('AuthKitPreview: this preview was destroyed.');
      resolved = resolvePreviewSpec(next);
      current = next;
      draw();
    },
    actions() {
      return [...stage().querySelectorAll('[data-auth-kit-action]')].map((el) => {
        const name = el.getAttribute('data-auth-kit-action')!;
        return { name, label: label(el), next: nextAfter(resolved, resolved.screen, name) };
      });
    },
    focus() {
      const summary = stage().querySelector<HTMLElement>('[data-auth-kit-slot="summary"]:not([hidden])');
      (summary ?? stage().querySelector<HTMLElement>('[data-auth-kit-slot="heading"]'))?.focus({ preventScroll: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.unmount();
      container.remove();
    },
  };
}

function renderBackdrop(host: HTMLElement, options: PreviewBackdropOptions): PreviewBackdropHandle {
  if (!(host instanceof HTMLElement)) throw new TypeError('AuthKitPreview.renderBackdrop(host, options): host must be an element.');
  return previewBackdrop(host, options);
}

const api = Object.freeze({
  version: __AUTH_KIT_VERSION__,
  /** Every screen, its states (the first is the default), and the component that draws it. */
  screens: PREVIEW_SCREENS,
  /** Every action name `onAction` reports. */
  actions: PREVIEW_ACTIONS,
  families: THEME_FAMILIES,
  cardStyles: CARD_STYLES,
  /** The card's width on each device, in CSS pixels. */
  widths: PREVIEW_CARD_WIDTH,
  /** The backdrop styles `renderBackdrop` draws: offered ones first-class, the rest (retired, `painted`) for the lab. */
  backdrops: Object.freeze(
    BACKDROP_STYLES.map((id) => {
      const style = backdropStyle(id)!;
      return Object.freeze({ id, label: style.label, description: style.description, versions: style.versions.length, offered: offeredStyles().includes(id) });
    }),
  ),
  /** The stylesheet `render` adds to the page (the card's, the backdrop's, and the stage's). */
  stylesheet: PREVIEW_STYLESHEET,
  render,
  renderBackdrop,
  /** Where `renderBackdrop` loads the backdrop styles from (`auth-kit-preview-backdrops.js` beside this file, by default). */
  get backdropsUrl(): string | null {
    return backdropsUrl();
  },
  set backdropsUrl(value: string | null) {
    setBackdropsUrl(value);
  },
});

export type AuthKitPreviewGlobal = typeof api;

(globalThis as unknown as { AuthKitPreview: AuthKitPreviewGlobal }).AuthKitPreview = api;
