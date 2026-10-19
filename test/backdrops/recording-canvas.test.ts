/**
 * The recording canvas's text calls: `fillText` is recorded into the hash, and `measureText` gives
 * deterministic widths (characters × 0.55 × the font's pixel size), so lettered styles are frozen too.
 */
import { describe, expect, it } from 'vitest';
import { nullContext, RecordingCanvas } from './recording-canvas.js';

describe('recording canvas text', () => {
  it('records fillText (and the font) into the hash', () => {
    const draw = (text: string, font = '700 40px system-ui, sans-serif') => {
      const ctx = new RecordingCanvas(100, 100).getContext('2d') as unknown as CanvasRenderingContext2D;
      ctx.font = font;
      ctx.fillText(text, 10, 20);
      return (ctx as unknown as { digest(): string; counts: { calls: number } });
    };
    expect(draw('A').digest()).toBe(draw('A').digest());
    expect(draw('A').digest()).not.toBe(draw('B').digest());
    expect(draw('A').digest()).not.toBe(draw('A', '700 41px system-ui, sans-serif').digest());
    expect(draw('A').counts.calls).toBe(2);
  });

  it('measures text from the font size', () => {
    const ctx = new RecordingCanvas(100, 100).getContext('2d') as unknown as CanvasRenderingContext2D;
    ctx.font = '700 40px system-ui, sans-serif';
    expect(ctx.measureText('Hello').width).toBeCloseTo(5 * 40 * 0.55);
    ctx.font = '12.5px sans-serif';
    expect(ctx.measureText('ab').width).toBeCloseTo(2 * 12.5 * 0.55);
    const quiet = nullContext();
    quiet.font = '20px sans-serif';
    expect(quiet.measureText('abc').width).toBeCloseTo(33);
  });
});
