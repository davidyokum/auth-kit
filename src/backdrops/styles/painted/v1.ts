/**
 * painted v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A slot for a finished image (a generated watercolor or oil painting): drawn cover-fitted around
 * its focal point. Until it loads, an optional tiny placeholder is drawn enlarged, which reads as a
 * blur, and the image fades in over it (instantly under reduced motion). Static: it redraws only
 * when an image arrives or the size changes.
 */
import { defineVersion } from '../define.js';
import type { Ctx2D } from '../define.js';

type Drawable = CanvasImageSource & { readonly width: number; readonly height: number };

const FADE_SECONDS = 0.6;

function drawCover(ctx: Ctx2D, image: Drawable, w: number, h: number, fx: number, fy: number): void {
  const iw = image.width;
  const ih = image.height;
  if (!(iw > 0 && ih > 0)) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.min(Math.max(fx * iw - sw / 2, 0), iw - sw);
  const sy = Math.min(Math.max(fy * ih - sh / 2, 0), ih - sh);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
}

export const paintedV1 = defineVersion({
  version: 1,
  fps: 0,
  maxPixelRatio: 2,
  stillTime: 0,
  colors: (p) => ({ page: p.page }),
  create(setup, c) {
    const { width: w, height: h, image, loadImage } = setup;
    const fx = Math.min(1, Math.max(0, image?.focus?.x ?? 0.5));
    const fy = Math.min(1, Math.max(0, image?.focus?.y ?? 0.5));
    let placeholder: Drawable | null = null;
    let full: Drawable | null = null;
    let fadeFrom = -1;
    let alive = true;
    if (image && loadImage) {
      if (image.placeholder) {
        loadImage(image.placeholder).then(
          (img) => {
            if (!alive) return;
            placeholder = img;
            if (!full) setup.invalidate();
          },
          () => undefined,
        );
      }
      loadImage(image.src).then(
        (img) => {
          if (!alive) return;
          full = img;
          setup.invalidate(setup.motion && placeholder ? FADE_SECONDS * 1000 + 100 : 0);
        },
        () => undefined,
      );
    }
    return {
      draw(ctx, frame) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.page;
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (placeholder) drawCover(ctx, placeholder, w, h, fx, fy);
        if (full) {
          if (fadeFrom < 0) fadeFrom = frame.t;
          const a = setup.motion && placeholder ? Math.min(1, (frame.t - fadeFrom) / FADE_SECONDS) : 1;
          ctx.globalAlpha = a;
          drawCover(ctx, full, w, h, fx, fy);
          ctx.globalAlpha = 1;
        }
      },
      destroy() {
        alive = false;
      },
      hot: [drawCover],
    };
  },
});
