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
 * - A style that letters the site's name (Yokum magnetic, given `siteName`) marks the root
 *   `data-backdrop-site-name="shown"` while the name is on the page (from the server's HTML on; taken
 *   off when the art can't show it), and `SignIn`'s heading then shows "Sign in" with the name kept for
 *   screen readers (auth-kit's styles, `authKitStyles`).
 * - On a touch screen, a swipe that starts on the art plays with it rather than scrolling, when the
 *   page has nothing to scroll; swipes on the card or a control, and pinches, are the page's as usual.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { backdropPalette } from './families.js';
import { type BackdropController, type BackdropOptions, renderBackdrop } from './render.js';
import { nameRoom as nameRoomFor } from './name-room.js';
import { backdropStyle } from './styles/registry.js';

export interface BackdropProps extends Omit<BackdropOptions, 'card' | 'onReady' | 'onSiteName'> {
  /** Class for the outer element (size it: it's the area the backdrop fills). */
  className?: string;
  /** Class for the element around the children (it sits above the canvas). */
  contentClassName?: string;
  /** Stop animating (the frame stays). */
  paused?: boolean;
  children?: ReactNode;
}

const CARD_SELECTOR = '[data-backdrop-card]';
/** Where a touch that starts here is the card's or a control's own (it scrolls and taps as usual). */
const TOUCH_OWN = '[data-backdrop-card],a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[contenteditable]';

/** The art answers the pointer: drawn, and not a still frame (reduced motion, a slow device). */
function moving(controller: BackdropController | null): boolean {
  if (!controller) return false;
  const state = controller.state;
  return state !== 'unsupported' && state !== 'waiting' && state !== 'destroyed' && state !== 'paused' && controller.stats().stillReason === null;
}

/** Whether a style letters the site's name, before its code has loaded (so the server's HTML says so). */
function lettersSiteName(style: string, siteName: string | undefined): boolean {
  return backdropStyle(style)?.letters === 'site-name' && (siteName ?? '').trim() !== '';
}

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
  // Whether the art shows the site's name: the style's promise until the drawing says otherwise.
  const [nameShown, setNameShown] = useState<boolean | null>(null);
  const showsName = nameShown ?? lettersSiteName(style, siteName);
  // A version that letters the name above the card on phones asks the scene for room there (0.1.19).
  const nameRoom = nameRoomFor(style, styleVersion, siteName);

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
        onSiteName: (shown) => setNameShown(shown),
      });
      root.removeAttribute('data-backdrop-error');
      if (p.paused) controllerRef.current.pause();
    } catch (error) {
      root.setAttribute('data-backdrop-error', error instanceof Error ? error.message : String(error));
      setNameShown(false);
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
      setNameShown(false);
    }
  }, [style, seed, styleVersion, family, paletteKey, imageKey, subjectKey, siteName, stillOnSlowDevices, frameBudgetMs, interactive, reducedMotion, maxFps, maxPixelRatio, pixelRatio]);

  useEffect(() => {
    if (paused) controllerRef.current?.pause();
    else controllerRef.current?.resume();
  }, [paused]);

  // Touch: a swipe that starts on the art plays with it instead of scrolling the page, when the page
  // has nothing to scroll (on a phone, Safari otherwise takes the swipe for a scroll and the art loses
  // the finger after a move or two). A swipe that starts on the card or a control, a pinch, and any
  // page taller than the screen scroll and zoom as usual.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined') return;
    let playing = false;
    const fits = () => {
      const page = document.scrollingElement ?? document.documentElement;
      return page.scrollHeight <= window.innerHeight + 1 && page.scrollWidth <= window.innerWidth + 1;
    };
    const start = (event: TouchEvent) => {
      const p = latest.current;
      const target = event.target as Element | null;
      const style = backdropStyle(p.style);
      playing =
        event.touches.length === 1 &&
        p.interactive !== false &&
        p.paused !== true &&
        style !== undefined &&
        style.interactivity !== 'none' &&
        !(target && typeof target.closest === 'function' && target.closest(TOUCH_OWN)) &&
        moving(controllerRef.current) &&
        fits();
    };
    const move = (event: TouchEvent) => {
      if (!playing) return;
      if (event.touches.length !== 1) {
        playing = false;
        return;
      }
      if (event.cancelable) event.preventDefault();
    };
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    return () => {
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
    };
  }, []);

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
      data-backdrop-site-name={showsName ? 'shown' : undefined}
      style={{ position: 'relative', isolation: 'isolate', backgroundColor: pageColor(props), ...(nameRoom !== null && { '--ak-backdrop-name-room': `${nameRoom}px` }) }}
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
