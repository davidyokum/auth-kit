import { defineStyle } from '../define.js';
import { BASIN_KEYS } from './subjects.js';
import { riverBasinsV1 } from './v1.js';

export const riverBasins = defineStyle({
  id: 'river-basins',
  label: 'River Basins',
  description: 'A hydrology sheet of one North Carolina river basin, with its divide, main stem, and tributaries growing like a tree, then its name.',
  interactivity: 'pointer',
  generative: true,
  versions: [riverBasinsV1],
  subjects: { noun: 'river basin', sets: { all: BASIN_KEYS }, defaultSet: 'all', label: (key) => key },
});
