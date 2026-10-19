import { defineStyle, lazyVersion } from '../define.js';
import { BASIN_KEYS } from './subjects.js';

export const riverBasins = defineStyle({
  id: 'river-basins',
  label: 'River Basins',
  description: 'A hydrology sheet of one North Carolina river basin, with its divide, main stem, and tributaries growing like a tree, then its name.',
  interactivity: 'pointer',
  generative: true,
  // The drawing code loads on first use, in its own chunk.
  versions: [lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 40, settlesAt: 34 }, () => import('./v1.js').then((m) => m.riverBasinsV1))],
  subjects: { noun: 'river basin', sets: { all: BASIN_KEYS }, defaultSet: 'all', label: (key) => key },
});
