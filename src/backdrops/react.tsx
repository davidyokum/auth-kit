'use client';
/**
 * `auth-kit/backdrops/react`: `<Backdrop>`, the art behind the sign-in card, for React (Next.js App
 * Router client component; it renders on the server too, as a plain block in the page color, and
 * starts drawing in the browser).
 *
 * ```tsx
 * <Backdrop style="contours" seed="k3f9x2ab" styleVersion={1} family="osbm" className="auth-scene">
 *   <main className="auth-card" data-backdrop-card>…the sign-in card…</main>
 * </Backdrop>
 * ```
 *
 * - The canvas is `aria-hidden` and `pointer-events: none`, positioned behind the children, so it's
 *   invisible to assistive technology and never takes a click. Pointer effects come from passive
 *   window-level listeners (renderBackdrop).
 * - Mark the card with `data-backdrop-card`: styles keep their focal points visible around it, and
 *   taps on it never reach a style. Without one, a centered 380px card is assumed (register E5). The backdrop is
 *   never faded around the card; give the card its own contrast (solid surface, border, shadow).
 * - A backdrop that can't draw (a bad option, no canvas) leaves the page color and says why in
 *   `data-backdrop-error`; it never breaks the page it decorates.
 */
import { type ReactNode, useEffect, useRef } from 'react';
import { backdropPalette } from './families.js';
import { type BackdropController, type BackdropOptions, renderBackdrop } from './render.js';

export interface BackdropProps extends Omit<BackdropOptions, 'card' | 'onReady'> {
  /** Class for the outer element (size it: it's the area the backdrop fills). */
  className?: string;
  /** Class for the element around the children (it sits above the canvas). */
  contentClassName?: string;
  /** Stop animating (the frame stays). */
  paused?: boolean;
  children?: ReactNode;
}

const CARD_SELECTOR = '[data-backdrop-card]';

function pageColor(props: BackdropProps): string {
  try {
    return backdropPalette(props.family ?? 'personal', props.palette ?? {}).page;
  } catch {
    return '#f3f4f6';
  }
}

export function Backdrop(props: BackdropProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<BackdropController | null>(null);
  const cardRef = useRef<Element | null>(null);
  const { style, seed, styleVersion, family, interactive, reducedMotion, maxFps, maxPixelRatio, pixelRatio, paused } = props;
  const paletteKey = JSON.stringify(props.palette ?? null);
  const imageKey = JSON.stringify(props.image ?? null);
  const subjectKey = JSON.stringify(props.subject ?? null);
  const { siteName, stillOnSlowDevices, frameBudgetMs } = props;
  const latest = useRef(props);
  latest.current = props;

  // Start once; later prop changes go through update().
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const p = latest.current;
    cardRef.current = root.querySelector(CARD_SELECTOR);
    try {
      controllerRef.current = renderBackdrop(canvas, {
        style: p.style,
        seed: p.seed,
        ...(p.styleVersion !== undefined && { styleVersion: p.styleVersion }),
        ...(p.family !== undefined && { family: p.family }),
        ...(p.palette !== undefined && { palette: p.palette }),
        ...(p.image !== undefined && { image: p.image }),
        ...(p.subject !== undefined && { subject: p.subject }),
        ...(p.siteName !== undefined && { siteName: p.siteName }),
        ...(p.stillOnSlowDevices !== undefined && { stillOnSlowDevices: p.stillOnSlowDevices }),
        ...(p.frameBudgetMs !== undefined && { frameBudgetMs: p.frameBudgetMs }),
        ...(p.interactive !== undefined && { interactive: p.interactive }),
        ...(p.reducedMotion !== undefined && { reducedMotion: p.reducedMotion }),
        ...(p.maxFps !== undefined && { maxFps: p.maxFps }),
        ...(p.maxPixelRatio !== undefined && { maxPixelRatio: p.maxPixelRatio }),
        ...(p.pixelRatio !== undefined && { pixelRatio: p.pixelRatio }),
        card: cardRef.current,
        onReady: () => canvas.setAttribute('data-ready', ''),
      });
      root.removeAttribute('data-backdrop-error');
      if (p.paused) controllerRef.current.pause();
    } catch (error) {
      root.setAttribute('data-backdrop-error', error instanceof Error ? error.message : String(error));
    }
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const p = latest.current;
    try {
      controller.update({
        style,
        seed,
        styleVersion,
        family,
        palette: p.palette,
        image: p.image,
        subject: p.subject,
        siteName,
        stillOnSlowDevices,
        frameBudgetMs,
        interactive,
        reducedMotion,
        maxFps,
        maxPixelRatio,
        pixelRatio,
      });
      rootRef.current?.removeAttribute('data-backdrop-error');
    } catch (error) {
      rootRef.current?.setAttribute('data-backdrop-error', error instanceof Error ? error.message : String(error));
    }
  }, [style, seed, styleVersion, family, paletteKey, imageKey, subjectKey, siteName, stillOnSlowDevices, frameBudgetMs, interactive, reducedMotion, maxFps, maxPixelRatio, pixelRatio]);

  useEffect(() => {
    if (paused) controllerRef.current?.pause();
    else controllerRef.current?.resume();
  }, [paused]);

  // The card element can change when the children re-render (a new sign-in step): follow it.
  useEffect(() => {
    const card = rootRef.current?.querySelector(CARD_SELECTOR) ?? null;
    if (card !== cardRef.current) {
      cardRef.current = card;
      controllerRef.current?.update({ card });
    }
  });

  return (
    <div
      ref={rootRef}
      className={props.className}
      data-auth-kit-backdrop=""
      data-backdrop-style={style}
      style={{ position: 'relative', isolation: 'isolate', backgroundColor: pageColor(props) }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-auth-kit-backdrop-canvas=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', zIndex: 0 }}
      />
      <div className={props.contentClassName} data-auth-kit-backdrop-content="" style={{ position: 'relative', zIndex: 1 }}>
        {props.children}
      </div>
    </div>
  );
}

export { backdropStyles } from './css.js';
export type { BackdropFamily, BackdropImage, BackdropPalette } from './types.js';
export type { BackdropStyleId } from './styles/registry.js';
