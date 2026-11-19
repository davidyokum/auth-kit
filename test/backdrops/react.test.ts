import './preload.js';
// @vitest-environment jsdom
/**
 * `<Backdrop>`: server-renders as a plain block, draws in the browser behind its children, stays out
 * of the accessibility tree and the pointer's way, and never breaks the page it decorates.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backdrop } from '../../src/backdrops/react.js';
import { RecordingCanvas } from './recording-canvas.js';

const shadows = new WeakMap<HTMLCanvasElement, RecordingCanvas>();

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let shadow = shadows.get(this);
    if (!shadow) {
      shadow = new RecordingCanvas(this.width, this.height);
      shadows.set(this, shadow);
    }
    return shadow.getContext('2d') as never;
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const card = createElement('div', { 'data-backdrop-card': '' }, createElement('button', { type: 'button' }, 'Sign in with a passkey'));

describe('<Backdrop>', () => {
  it('server-renders a block in the page color, a hidden canvas that takes no pointer, and the children', () => {
    const html = renderToString(createElement(Backdrop, { style: 'aurora', seed: 'ssr', family: 'osbm' }, card));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('pointer-events:none');
    expect(html).toMatch(/background-color:#f3f4f6/);
    expect(html).toContain('Sign in with a passkey');
    expect(html).toContain('data-auth-kit-backdrop-canvas');
  });

  it('draws in the browser and marks the canvas ready after the first frame', () => {
    const { container } = render(createElement(Backdrop, { style: 'contours', seed: 'client', family: 'unc', className: 'scene' }, card));
    const canvas = container.querySelector('canvas')!;
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.style.pointerEvents).toBe('none');
    expect(canvas.hasAttribute('data-ready')).toBe(true);
    expect(container.firstElementChild?.className).toBe('scene');
    expect(container.firstElementChild?.hasAttribute('data-backdrop-error')).toBe(false);
  });

  it('says on its root when the art letters the site’s name, from the server’s HTML on', () => {
    const named = { style: 'yokum-magnetic', seed: 'ssr', siteName: 'Example Reports' } as const;
    expect(renderToString(createElement(Backdrop, named, card))).toContain('data-backdrop-site-name="shown"');
    expect(renderToString(createElement(Backdrop, { style: 'yokum-magnetic', seed: 'ssr' }, card))).not.toContain('data-backdrop-site-name');
    expect(renderToString(createElement(Backdrop, { style: 'aurora', seed: 'ssr', siteName: 'Example Reports' }, card))).not.toContain('data-backdrop-site-name');
    // In the browser the drawing decides: a 640×400 page has no room around the card for the title.
    const small = render(createElement(Backdrop, named, card));
    expect(small.container.firstElementChild?.hasAttribute('data-backdrop-site-name')).toBe(false);
    cleanup();
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
    const tall = render(createElement(Backdrop, named, card));
    expect(tall.container.firstElementChild?.getAttribute('data-backdrop-site-name')).toBe('shown');
  });

  it('asks the scene for room above the card when the version letters the name there (0.1.19)', () => {
    const room = (props: Record<string, unknown>) => {
      const html = renderToString(createElement(Backdrop, { style: 'yokum-magnetic', seed: 'room', ...props } as never, card));
      return /--ak-backdrop-name-room:\s*([0-9]+px)/.exec(html)?.[1] ?? null;
    };
    expect(room({ styleVersion: 2, siteName: 'Example Site' })).toBe('64px');
    expect(room({ siteName: 'Example Site' })).toBe('64px');
    // Version 1 doesn't ask (it letters the name below the card on phones); with no name there's nothing to letter.
    expect(room({ styleVersion: 1, siteName: 'Example Site' })).toBeNull();
    expect(room({ styleVersion: 2 })).toBeNull();
    expect(room({ styleVersion: 2, siteName: '  ' })).toBeNull();
    const html = renderToString(createElement(Backdrop, { style: 'aurora', seed: 'room', siteName: 'Example Site' }, card));
    expect(html).not.toContain('--ak-backdrop-name-room');
  });

  it('on a touch screen, a swipe that starts on the art plays with it; one on the card scrolls as usual', () => {
    const { container } = render(createElement(Backdrop, { style: 'yokum-magnetic', seed: 'touch', siteName: 'Example Reports' }, card));
    const root = container.firstElementChild!;
    const swipe = (target: Element) => {
      fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }] });
      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(move, 'touches', { value: [{ clientX: 40, clientY: 12 }] });
      target.dispatchEvent(move);
      return move.defaultPrevented;
    };
    expect(swipe(root)).toBe(true);
    expect(swipe(screen.getByRole('button', { name: 'Sign in with a passkey' }))).toBe(false);
    expect(swipe(root.querySelector('[data-backdrop-card]')!)).toBe(false);
  });

  it('leaves clicks to the children', () => {
    const onClick = vi.fn();
    render(createElement(Backdrop, { style: 'ripples', seed: 'click' }, createElement('button', { type: 'button', onClick }, 'Continue')));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps the page when an option is wrong, and says why', () => {
    const { container } = render(createElement(Backdrop, { style: 'nope' as never, seed: 'x' }, card));
    expect(container.firstElementChild?.getAttribute('data-backdrop-error')).toMatch(/no style "nope"/);
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeTruthy();
  });

  it('follows prop changes in place, and cleans up on unmount', () => {
    const { container, rerender, unmount } = render(createElement(Backdrop, { style: 'aurora', seed: 'a' }, card));
    act(() => rerender(createElement(Backdrop, { style: 'stained-glass', seed: 'b', family: 'personal' }, card)));
    expect(container.firstElementChild?.getAttribute('data-backdrop-style')).toBe('stained-glass');
    expect(container.firstElementChild?.hasAttribute('data-backdrop-error')).toBe(false);
    unmount();
  });
});
