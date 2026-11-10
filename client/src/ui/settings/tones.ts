import type { StandardStatus } from './model';
import type { Tone } from '../types';

/** The tone of the chip of each state of a standard. */
export const STANDARD_TONE: Record<StandardStatus, Tone> = {
  covered: 'green',
  'in-progress': 'amber',
  partial: 'amber',
  'to-certify': 'amber',
  'to-request': 'amber',
  'to-verify': 'neutral',
  'by-others': 'neutral',
};
