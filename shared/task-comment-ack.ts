import type { TaskComment } from './board';

/** Acceptance describes routing, never an unobserved agent response. */
export type TaskCommentAcknowledgement = TaskComment & {
  delivery: 'note' | 'queued' | 'answered';
};
