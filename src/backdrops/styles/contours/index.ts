import { defineStyle, lazyVersion } from '../define.js';

export const contours = defineStyle({
  id: 'contours',
  label: 'Contours',
  description: 'A topographic map with softly tinted terraces that drifts very slowly.',
  interactivity: 'none',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 6, maxPixelRatio: 2, stillTime: 40 }, () => import('./v1.js').then((m) => m.contoursV1))],
});
