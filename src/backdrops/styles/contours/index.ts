import { defineStyle } from '../define.js';
import { contoursV1 } from './v1.js';

export const contours = defineStyle({
  id: 'contours',
  label: 'Contours',
  description: 'A topographic map with softly tinted terraces that drifts very slowly.',
  interactivity: 'none',
  generative: true,
  versions: [contoursV1],
});
