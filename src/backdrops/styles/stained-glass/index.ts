import { defineStyle } from '../define.js';
import { stainedGlassV1 } from './v1.js';

export const stainedGlass = defineStyle({
  id: 'stained-glass',
  label: 'Stained glass',
  description: 'Soft glass cells in light leading; the cell nearest the pointer lights up.',
  interactivity: 'pointer',
  generative: true,
  versions: [stainedGlassV1],
});
