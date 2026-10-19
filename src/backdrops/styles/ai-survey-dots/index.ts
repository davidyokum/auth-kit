import { defineStyle } from '../define.js';
import { aiSurveyDotsV1 } from './v1.js';

export const aiSurveyDots = defineStyle({
  id: 'ai-survey-dots',
  label: 'AI Survey dots',
  description: 'Faint gray dots on off-white that ease aside, grow, and turn blue as the pointer passes.',
  interactivity: 'pointer',
  generative: true,
  versions: [aiSurveyDotsV1],
});
