import { defineStyle } from '../define.js';
import { paintedV1 } from './v1.js';

export const painted = defineStyle({
  id: 'painted',
  label: 'Painted',
  description: 'A finished image (a generated watercolor or oil painting) behind the card, with a blur-up placeholder.',
  interactivity: 'none',
  // Needs an image, so it's never picked from a seed alone.
  generative: false,
  versions: [paintedV1],
});
