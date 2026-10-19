/**
 * The preview's stage: the box a held card is drawn in (ADR 0025). Desktop: the card with 92px each side
 * (room for the Plain style's column to fade) and 48px above and below. Phone: a 375px-wide screen with
 * 16px margins, which also turns on the card's phone layout (`data-auth-kit-device="phone"`, the same
 * rules `authKitStyles` applies under 480px). The stage contains its layout, so the Plain style's
 * full-height column stays inside it when many cards share a page. Zero specificity, like the card's own.
 */
import { backdropStyles } from '../backdrops/css.js';
import { authKitStyles } from '../client/styles.js';

export const authKitPreviewStyles = `
:where([data-auth-kit-preview]) { box-sizing: border-box; position: relative; contain: layout; width: calc(var(--ak-card-width, 380px) + 184px); max-width: 100%; padding: 48px 92px; font-family: var(--ak-preview-font, system-ui, sans-serif); font-size: 16px; line-height: 1.5; text-align: start; color-scheme: light; color: #1f2328; }
:where([data-auth-kit-preview][data-auth-kit-preview-theme="dark"]) { color-scheme: dark; color: #e6e8eb; }
:where([data-auth-kit-preview][data-auth-kit-preview-ground]) { background: var(--ak-preview-ground); }
:where([data-auth-kit-preview][data-auth-kit-device="phone"]) { width: 375px; padding: 24px 16px; }
:where([data-auth-kit-preview][data-auth-kit-preview-style="plain"]) { overflow: hidden; }
:where([data-auth-kit-preview] [data-auth-kit-preview-qr]) { display: block; width: 168px; height: 168px; }
`.trim();

/** Everything a preview needs: the card's styles, the backdrop's, and the stage's. */
export const PREVIEW_STYLESHEET = `${authKitStyles}\n${backdropStyles}\n${authKitPreviewStyles}`;

const STYLE_ATTRIBUTE = 'data-auth-kit-preview-styles';

/**
 * Adds the preview's stylesheet to the document (or the shadow root) `node` is in, once. The card's
 * styles go in with it, so a host page needs nothing else.
 */
export function ensurePreviewStyles(node: Node): void {
  const doc = node.ownerDocument ?? (node as Document);
  const root = node.getRootNode();
  const parent: ParentNode | null = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : doc.head;
  if (!parent || parent.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = PREVIEW_STYLESHEET;
  parent.appendChild(style);
}
