// @vitest-environment jsdom
/**
 * The dev-only picker: nine variations behind the real card, shuffle, style filter, family preview,
 * and "Use this one" handing the choice to the site. It carries the marker check-prod-build finds.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackdropPicker, type BackdropPickerProps } from '../../src/backdrops/picker.js';
import { BACKDROP_PICKER_MARKER } from '../../src/dev/marker.js';
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
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 250 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(extra: Partial<BackdropPickerProps> = {}) {
  const renderCard = vi.fn((family: string) => createElement('div', { 'data-backdrop-card': '' }, `Card for ${family}`));
  const onUse = vi.fn(() => Promise.resolve({ message: 'Saved to site.config.ts.', detail: 'backup: site.config.ts.bak' }));
  const view = render(
    createElement(BackdropPicker, {
      siteName: 'Example Site',
      family: 'osbm',
      current: null,
      proposed: { style: 'aurora', seed: 'proposed', styleVersion: 1 },
      renderCard,
      onUse,
      initialSalt: 'picker-test',
      ...extra,
    }),
  );
  return { ...view, renderCard, onUse };
}

const tiles = () => screen.getAllByRole('button', { name: /^Variation \d/ });

describe('BackdropPicker', () => {
  it('shows nine variations behind the real card, and carries the dev-only marker', async () => {
    const { container, renderCard } = setup();
    await waitFor(() => expect(tiles()).toHaveLength(9));
    expect(container.querySelector(`[data-auth-kit-backdrop-picker="${BACKDROP_PICKER_MARKER}"]`)).not.toBeNull();
    expect(renderCard).toHaveBeenCalledWith('osbm');
    expect(screen.getByRole('heading', { name: 'Choose a backdrop for Example Site' })).toBeTruthy();
    expect(screen.getByText('Not locked')).toBeTruthy();
    // Previews hold the real card (with its own buttons), so no preview may sit inside a button.
    expect(container.querySelector('button button, button form, button input')).toBeNull();
  });

  it('shuffles to nine new seeds, and goes back to the previous nine', async () => {
    setup();
    await waitFor(() => expect(tiles()).toHaveLength(9));
    const before = tiles().map((t) => t.getAttribute('aria-label'));
    fireEvent.click(screen.getByRole('button', { name: /Shuffle/ }));
    const after = tiles().map((t) => t.getAttribute('aria-label'));
    expect(after).not.toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Previous nine' }));
    expect(tiles().map((t) => t.getAttribute('aria-label'))).toEqual(before);
  });

  it('filters to one style and previews another family', async () => {
    const { renderCard } = setup();
    await waitFor(() => expect(tiles()).toHaveLength(9));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'contours' } });
    for (const tile of tiles()) expect(tile.getAttribute('aria-label')).toMatch(/: Contours,/);
    fireEvent.click(screen.getByRole('radio', { name: 'UNC-Chapel Hill' }));
    expect(renderCard).toHaveBeenCalledWith('unc');
    expect(screen.getByText(/Previewing UNC-Chapel Hill colors/)).toBeTruthy();
  });

  it('opens a variation large and saves it with "Use this one"', async () => {
    const { onUse } = setup();
    await waitFor(() => expect(tiles()).toHaveLength(9));
    const label = tiles()[2]!.getAttribute('aria-label')!;
    const seed = /seed (\w+)\./.exec(label)![1];
    fireEvent.click(tiles()[2]!);
    expect(screen.getByText('Variation 3 of 9')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use this one' }));
      await Promise.resolve();
    });
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ seed, styleVersion: 1 }));
    expect(screen.getByText('Saved to site.config.ts.')).toBeTruthy();
    expect(screen.getByText('backup: site.config.ts.bak')).toBeTruthy();
  });

  it('shows an error from the site instead of claiming success', async () => {
    setup({ onUse: () => Promise.reject(new Error('site.config.ts has no backdrop line')) });
    await waitFor(() => expect(tiles()).toHaveLength(9));
    fireEvent.click(tiles()[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use this one' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/no backdrop line/);
  });

  it('marks a locked backdrop, and doesn’t offer to "use" the one already in use', async () => {
    setup({ current: { style: 'ripples', seed: 'locked1', styleVersion: 1, locked: true } });
    await waitFor(() => expect(tiles()).toHaveLength(9));
    expect(screen.getByText('Locked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ripples v1 · locked1\. Open it large/ }));
    expect(screen.getByText('This is the site’s backdrop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this one' })).toBeNull();
  });
});
