/**
 * The room a scene leaves above the card for a backdrop that letters the site's name there (0.1.19).
 * Framework-free: `<Backdrop>` and the preview set it as `--ak-backdrop-name-room`.
 */
import { backdropStyle, resolveStyleVersion } from './styles/registry.js';

/**
 * The room, in CSS px, the scene should leave above the card for the site's name (a style version's
 * `nameRoom`, Yokum magnetic v2), or null when the art doesn't letter the name there.
 */
export function nameRoom(style: string, styleVersion: number | undefined, siteName: string | undefined): number | null {
  if (backdropStyle(style)?.letters !== 'site-name' || (siteName ?? '').trim() === '') return null;
  try {
    return resolveStyleVersion(style, styleVersion).version.nameRoom ?? null;
  } catch {
    return null;
  }
}
