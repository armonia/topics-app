import type { TaskComment } from './board';

/** Acceptance describes routing, never an unobserved agent response. */
export type TaskCommentAcknowledgement = TaskComment & {
  delivery: 'note' | 'queued' | 'answered';
};
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
