import { defineStyle } from '../define.js';
import { constellationV1 } from './v1.js';

export const constellation = defineStyle({
  id: 'constellation',
  label: 'Constellation',
  description: 'Drifting points joined by faint links that reach for the pointer.',
  interactivity: 'pointer',
  generative: true,
  versions: [constellationV1],
});
