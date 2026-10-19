import { defineStyle, lazyVersion } from '../define.js';
import { ALL_CONSTELLATIONS, CONSTELLATION_NAMES, CURATED_CONSTELLATIONS } from './subjects.js';

export const starChart = defineStyle({
  id: 'star-chart',
  label: 'Star Chart',
  description: 'A celestial chart plate that plots one constellation star by star, draws its figure, and letters its name and meaning.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 40, settlesAt: 29 }, () => import('./v1.js').then((m) => m.starChartV1))],
  subjects: {
    noun: 'constellation',
    sets: { curated: CURATED_CONSTELLATIONS, all: ALL_CONSTELLATIONS },
    defaultSet: 'curated',
    label: (key) => CONSTELLATION_NAMES[key] ?? key,
  },
});
