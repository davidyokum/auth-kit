import { defineStyle, lazyVersion } from '../define.js';

export const painted = defineStyle({
  id: 'painted',
  label: 'Painted',
  description: 'A finished image (a generated watercolor or oil painting) behind the card, with a blur-up placeholder.',
  interactivity: 'none',
  // Needs an image, so it's never picked from a seed alone.
  generative: false,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 0, maxPixelRatio: 2, stillTime: 0 }, () => import('./v1.js').then((m) => m.paintedV1))],
});
