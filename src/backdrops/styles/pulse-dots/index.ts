import { defineStyle } from '../define.js';
import { pulseDotsV1 } from './v1.js';

export const pulseDots = defineStyle({
  id: 'pulse-dots',
  label: 'Pulse dots',
  description: 'Faint gray dots on white that ease aside, grow, and turn blue as the pointer passes.',
  interactivity: 'pointer',
  generative: true,
  versions: [pulseDotsV1],
});
