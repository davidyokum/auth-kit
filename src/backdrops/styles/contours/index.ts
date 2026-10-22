import { defineStyle, lazyVersion } from '../define.js';

export const contours = defineStyle({
  id: 'contours',
  label: 'Contours',
  description: 'A topographic map with softly tinted terraces that drifts slowly; a hill rises under the pointer (v2).',
  // v1 ignores the pointer; v2 raises a hill under it (ADR 0026).
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [
    lazyVersion({ version: 1, fps: 6, maxPixelRatio: 2, stillTime: 40 }, () => import('./v1.js').then((m) => m.contoursV1)),
    lazyVersion({ version: 2, fps: 60, maxPixelRatio: 2, stillTime: 40 }, () => import('./v2.js').then((m) => m.contoursV2)),
  ],
});
