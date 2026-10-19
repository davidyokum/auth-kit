import { defineStyle, lazyVersion } from '../define.js';

export const ripples = defineStyle({
  id: 'ripples',
  label: 'Ripples',
  description: 'Fine concentric rings spreading on still water; a tap starts a ripple.',
  interactivity: 'tap',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 24, maxPixelRatio: 2, stillTime: 23 }, () => import('./v1.js').then((m) => m.ripplesV1))],
});
