import { defineStyle } from '../define.js';
import { ALL_CONSTELLATIONS, CONSTELLATION_NAMES, CURATED_CONSTELLATIONS } from './subjects.js';
import { starChartV1 } from './v1.js';

export const starChart = defineStyle({
  id: 'star-chart',
  label: 'Star Chart',
  description: 'A celestial chart plate that plots one constellation star by star, draws its figure, and letters its name and meaning.',
  interactivity: 'pointer',
  generative: true,
  versions: [starChartV1],
  subjects: {
    noun: 'constellation',
    sets: { curated: CURATED_CONSTELLATIONS, all: ALL_CONSTELLATIONS },
    defaultSet: 'curated',
    label: (key) => CONSTELLATION_NAMES[key] ?? key,
  },
});
