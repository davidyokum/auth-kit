'use client';
/**
 * `auth-kit/preview`: preview mode (ADR 0025). The real sign-in screens (the components and words
 * `auth-kit/client` ships), held at any screen and state with sample data, and inert: no Amplify or
 * Cognito calls, no network, no storage writes, no clipboard, no navigation. Every click or submit is
 * reported (`onAction`) and changes nothing.
 *
 * For design tools (the Sign-in Studio), documentation screenshots (the primer's walkthrough), and
 * auth-kit's own screenshot tests. Never for a site's sign-in page: it carries `PREVIEW_MARKER`, so
 * `auth-kit check-prod-build` fails a production build that bundled it. A page without a build step
 * uses the standalone file each GitHub Release carries (`auth-kit-preview.js`, `window.AuthKitPreview`).
 *
 * ```tsx
 * import { AuthKitPreview } from 'auth-kit/preview';
 * <AuthKitPreview spec={{ screen: 'password', state: 'wrong', family: 'osbm', cardStyle: 'porcelain' }} />
 * ```
 */
export { AuthKitPreview, previewKey, type AuthKitPreviewProps } from './Preview.js';
export {
  PREVIEW_SCREENS,
  PREVIEW_ACTIONS,
  SAMPLE_SETUP_KEY,
  findScreen,
  nextAfter,
  placementOf,
  resolvePreviewSpec,
  type PreviewComponent,
  type PreviewGroup,
  type PreviewPlacement,
  type PreviewScreen,
  type PreviewState,
} from './screens.js';
export {
  PREVIEW_CARD_WIDTH,
  PREVIEW_DEFAULTS,
  PreviewSpecError,
  type PreviewActionHandler,
  type PreviewActionInfo,
  type PreviewDevice,
  type PreviewSpec,
  type PreviewTheme,
  type ResolvedPreviewSpec,
} from './spec.js';
export { previewDriver, type PreviewDriverOptions } from './driver.js';
export { previewBackdrop, type PreviewBackdropHandle, type PreviewBackdropOptions } from './backdrop.js';
export { authKitPreviewStyles, ensurePreviewStyles, PREVIEW_STYLESHEET } from './styles.js';
export { sampleQrCode } from './qr.js';
export { PREVIEW_MARKER } from '../dev/marker.js';
