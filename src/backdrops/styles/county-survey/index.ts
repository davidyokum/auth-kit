import { defineStyle, lazyVersion } from '../define.js';
import { COUNTY_KEYS } from './subjects.js';

export const countySurvey = defineStyle({
  id: 'county-survey',
  label: 'County Survey',
  description: 'A pen plotter surveys one North Carolina county, with its outline, water, roads, and seat, then letters its name.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 40, settlesAt: 35 }, () => import('./v1.js').then((m) => m.countySurveyV1))],
  subjects: { noun: 'county', sets: { all: COUNTY_KEYS }, defaultSet: 'all', label: (key) => key },
});
