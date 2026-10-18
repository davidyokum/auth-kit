import { defineStyle } from '../define.js';
import { flowLinesV1 } from './v1.js';

export const flowLines = defineStyle({
  id: 'flow-lines',
  label: 'Flow lines',
  description: 'Long, fine curves that follow a slowly turning current and bend around the pointer.',
  interactivity: 'pointer',
  generative: true,
  versions: [flowLinesV1],
});
