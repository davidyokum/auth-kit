import { defineStyle, lazyVersion } from '../define.js';

export const yokumMagnetic = defineStyle({
  id: 'yokum-magnetic',
  label: 'Yokum magnetic',
  description: 'Iron filings swirl around the pointer, the big letters of the site name fall when touched, and a red magnet springs them home.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 2, settlesAt: 1 }, () => import('./v1.js').then((m) => m.yokumMagneticV1))],
});
