import { defineStyle, lazyVersion } from '../define.js';

export const magneticDots = defineStyle({
  id: 'magnetic-dots',
  label: 'Magnetic dots',
  description: 'A halftone dot field that drifts slowly; dots lean toward the pointer.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 12 }, () => import('./v1.js').then((m) => m.magneticDotsV1))],
});
