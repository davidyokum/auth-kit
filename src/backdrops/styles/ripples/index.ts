import { defineStyle } from '../define.js';
import { ripplesV1 } from './v1.js';

export const ripples = defineStyle({
  id: 'ripples',
  label: 'Ripples',
  description: 'Fine concentric rings spreading on still water; a tap starts a ripple.',
  interactivity: 'tap',
  generative: true,
  versions: [ripplesV1],
});
