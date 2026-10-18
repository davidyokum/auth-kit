import { defineStyle } from '../define.js';
import { watercolorV1 } from './v1.js';

export const watercolor = defineStyle({
  id: 'watercolor',
  label: 'Watercolor',
  description: 'Translucent washes on grained paper, painted in code, that bleed very slowly.',
  interactivity: 'none',
  generative: true,
  versions: [watercolorV1],
});
