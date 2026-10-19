import { defineStyle, lazyVersion } from '../define.js';

export const pulseDots = defineStyle({
  id: 'pulse-dots',
  label: 'Pulse dots',
  description: 'Faint gray dots on white that ease aside, grow, and turn blue as the pointer passes.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 2, settlesAt: 1 }, () => import('./v1.js').then((m) => m.pulseDotsV1))],
});
