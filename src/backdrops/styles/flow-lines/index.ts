import { defineStyle, lazyVersion } from '../define.js';

export const flowLines = defineStyle({
  id: 'flow-lines',
  label: 'Flow lines',
  description: 'Long, fine curves that follow a slowly turning current and bend around the pointer.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 20, maxPixelRatio: 2, stillTime: 18 }, () => import('./v1.js').then((m) => m.flowLinesV1))],
});
