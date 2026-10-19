import { defineStyle } from '../define.js';
import { yokumMagneticV1 } from './v1.js';

export const yokumMagnetic = defineStyle({
  id: 'yokum-magnetic',
  label: 'Yokum magnetic',
  description: 'Iron filings swirl around the pointer, the big letters of the site name fall when touched, and a red magnet springs them home.',
  interactivity: 'pointer',
  generative: true,
  versions: [yokumMagneticV1],
});
