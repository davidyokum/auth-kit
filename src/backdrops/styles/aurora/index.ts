import { defineStyle, lazyVersion } from '../define.js';

export const aurora = defineStyle({
  id: 'aurora',
  label: 'Aurora',
  description: 'Soft curtains of light in the brand tints that drift and shimmer gently.',
  interactivity: 'none',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 15, maxPixelRatio: 1, stillTime: 25 }, () => import('./v1.js').then((m) => m.auroraV1))],
});
