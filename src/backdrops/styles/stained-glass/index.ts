import { defineStyle, lazyVersion } from '../define.js';

export const stainedGlass = defineStyle({
  id: 'stained-glass',
  label: 'Stained glass',
  description: 'Soft glass cells in light leading; the cell nearest the pointer lights up.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 15, maxPixelRatio: 2, stillTime: 15 }, () => import('./v1.js').then((m) => m.stainedGlassV1))],
});
