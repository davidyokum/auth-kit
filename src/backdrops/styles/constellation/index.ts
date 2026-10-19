import { defineStyle, lazyVersion } from '../define.js';

export const constellation = defineStyle({
  id: 'constellation',
  label: 'Constellation',
  description: 'Drifting points joined by faint links that reach for the pointer.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 24, maxPixelRatio: 2, stillTime: 20 }, () => import('./v1.js').then((m) => m.constellationV1))],
});
