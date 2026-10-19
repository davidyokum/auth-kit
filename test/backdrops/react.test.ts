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
