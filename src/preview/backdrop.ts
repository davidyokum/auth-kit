/**
 * `previewBackdrop(host, options)`: a backdrop from auth-kit's own registry behind a previewed card
 * (ADR 0025). Framework-free. The art is the same code a site runs (`renderBackdrop`); the preview
 * only chooses safe defaults: no subject tour (a tour keeps its place in localStorage), and the dark
 * page a lab view asks for.
 */
import { BACKDROP_FAMILIES } from '../backdrops/families.js';
import { type BackdropController, renderBackdrop } from '../backdrops/render.js';
import { backdropStyle, BACKDROP_STYLES, type BackdropStyleId, isBackdropStyleId } from '../backdrops/styles/registry.js';
import type { BackdropSubjectOptions } from '../backdrops/subjects.js';
import type { BackdropImage, BackdropRect } from '../backdrops/types.js';
import type { ThemeFamily } from '../themes/index.js';
import type { PreviewTheme } from './spec.js';

export interface PreviewBackdropOptions {
  /** A style from the registry (`BACKDROP_STYLES`). */
  style: BackdropStyleId;
  /** Any string or number: the same seed draws the same art for a style version. */
  seed: string | number;
  /** Default: the newest. */
  styleVersion?: number;
  /** Default `personal`. */
  family?: ThemeFamily;
  /**
   * `dark` paints on the family's ink instead of its page: a lab view only (every released palette is a
   * light page, ADR 0021); styles with a dark treatment use theirs.
   */
  theme?: PreviewTheme;
  /** A still frame, never animated. Default: animate unless the browser asks for reduced motion. */
  still?: boolean;
  /** Pointer and tap effects. Default false (a preview is looked at, not played with). */
  interactive?: boolean;
  /**
   * Styles with subjects (County Survey, River Basins, Star Chart): which subject. Default the subject
   * of the day; `{ rotation: 'fixed', key }` for a picture that never changes. A `tour` (which keeps its
   * place in localStorage) draws the subject of the day instead.
   */
  subject?: BackdropSubjectOptions;
  /** The site's name, for styles that letter it. */
  siteName?: string;
  /** `painted` only: the image (the browser loads it from its URL). */
  image?: BackdropImage;
  /** Where the card sits. Default: the `[data-backdrop-card]` inside `host`, followed as it moves. */
  card?: Element | BackdropRect | null;
}

export interface PreviewBackdropHandle {
  /** The canvas, the first child of `host`, behind everything else in it. */
  readonly el: HTMLCanvasElement;
  /** Resolves after the first frame (a style's code loads on first use). */
  readonly ready: Promise<void>;
  /** Why it couldn't draw, when it couldn't (a bad option, no canvas); also on `host` as `data-backdrop-error`. */
  readonly error: string | null;
  update(options: Partial<PreviewBackdropOptions>): void;
  destroy(): void;
}

function artOptions(options: PreviewBackdropOptions) {
  const family = options.family ?? 'personal';
  const subject = options.subject?.rotation === 'tour' ? { ...options.subject, rotation: 'day' as const } : options.subject;
  const hasSubjects = backdropStyle(options.style)?.subjects !== undefined;
  // Every key, even when undefined: an update replaces what a previous style or theme set.
  return {
    style: options.style,
    seed: options.seed,
    family,
    styleVersion: options.styleVersion,
    palette: options.theme === 'dark' ? { page: BACKDROP_FAMILIES[family].palette.ink } : undefined,
    subject: hasSubjects ? (subject ?? { rotation: 'day' as const }) : undefined,
    siteName: options.siteName,
    image: options.image,
    reducedMotion: options.still === true ? true : ('auto' as const),
    interactive: options.interactive ?? false,
  };
}

/**
 * Draws a backdrop behind `host`'s content: a canvas as `host`'s first child, filling it (`host` gets
 * `position: relative` if it has none). Never throws for a bad option: it leaves the page color and
 * reports why (`error`, `data-backdrop-error`), as `<Backdrop>` does.
 */
export function previewBackdrop(host: HTMLElement, options: PreviewBackdropOptions): PreviewBackdropHandle {
  const doc = host.ownerDocument;
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('data-auth-kit-backdrop-canvas', '');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
  if (doc.defaultView?.getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.prepend(canvas);

  let current = { ...options };
  let controller: BackdropController | null = null;
  let error: string | null = null;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const fail = (e: unknown) => {
    error = e instanceof Error ? e.message : String(e);
    host.setAttribute('data-backdrop-error', error);
  };
  const cardOf = () => (current.card !== undefined ? current.card : host.querySelector('[data-backdrop-card]'));

  try {
    if (!isBackdropStyleId(current.style)) throw new Error(`auth-kit/preview: there's no backdrop style "${String(current.style)}". Styles: ${BACKDROP_STYLES.join(', ')}.`);
    controller = renderBackdrop(canvas, {
      ...artOptions(current),
      card: cardOf(),
      onReady: () => {
        canvas.setAttribute('data-ready', '');
        resolveReady();
      },
    });
  } catch (e) {
    fail(e);
  }

  return {
    el: canvas,
    ready,
    get error() {
      return error;
    },
    update(next) {
      current = { ...current, ...next };
      if (!controller) return;
      try {
        controller.update({ ...artOptions(current), card: cardOf() });
        error = null;
        host.removeAttribute('data-backdrop-error');
      } catch (e) {
        fail(e);
      }
    },
    destroy() {
      controller?.destroy();
      controller = null;
      canvas.remove();
    },
  };
}
