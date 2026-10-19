import { defineStyle } from '../define.js';
import { COUNTY_KEYS } from './subjects.js';
import { countySurveyV1 } from './v1.js';

export const countySurvey = defineStyle({
  id: 'county-survey',
  label: 'County Survey',
  description: 'A pen plotter surveys one North Carolina county, with its outline, water, roads, and seat, then letters its name.',
  interactivity: 'pointer',
  generative: true,
  versions: [countySurveyV1],
  subjects: { noun: 'county', sets: { all: COUNTY_KEYS }, defaultSet: 'all', label: (key) => key },
});
