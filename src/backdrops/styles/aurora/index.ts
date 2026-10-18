import { defineStyle } from '../define.js';
import { auroraV1 } from './v1.js';

export const aurora = defineStyle({
  id: 'aurora',
  label: 'Aurora',
  description: 'Soft curtains of light in the brand tints that drift and shimmer gently.',
  interactivity: 'none',
  generative: true,
  versions: [auroraV1],
});
