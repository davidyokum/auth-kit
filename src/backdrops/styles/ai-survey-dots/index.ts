import { defineStyle, lazyVersion } from '../define.js';

export const aiSurveyDots = defineStyle({
  id: 'ai-survey-dots',
  label: 'AI Survey dots',
  description: 'Faint gray dots on off-white that ease aside, grow, and turn blue as the pointer passes.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 2, settlesAt: 1 }, () => import('./v1.js').then((m) => m.aiSurveyDotsV1))],
});
