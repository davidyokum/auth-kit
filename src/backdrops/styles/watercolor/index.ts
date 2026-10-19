import { defineStyle, lazyVersion } from '../define.js';

export const watercolor = defineStyle({
  id: 'watercolor',
  label: 'Watercolor',
  description: 'Translucent washes on grained paper, painted in code, that bleed very slowly.',
  interactivity: 'none',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 6, maxPixelRatio: 1.25, stillTime: 30 }, () => import('./v1.js').then((m) => m.watercolorV1))],
});
