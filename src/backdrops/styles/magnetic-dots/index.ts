import { defineStyle } from '../define.js';
import { magneticDotsV1 } from './v1.js';

export const magneticDots = defineStyle({
  id: 'magnetic-dots',
  label: 'Magnetic dots',
  description: 'A halftone dot field that drifts slowly; dots lean toward the pointer.',
  interactivity: 'pointer',
  generative: true,
  versions: [magneticDotsV1],
});
