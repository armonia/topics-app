/**
 * A board recurrence as the API returns it (KANBAN-95). Server and client both
 * import it from here, so the two sides cannot drift.
 */
import type { TaskLabel } from './task-labels';

/** The columns a recurrence can start its card in: every status but `done`. */
export type ScheduledStatus = 'backlog' | 'todo' | 'in_progress' | 'review';

export interface ScheduledCard {
  id: string;
  projectId: string;
  text: string;
  status: ScheduledStatus;
  labels: TaskLabel[];
  cron: string;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastResult: 'created' | 'skipped' | null;
  lastReason: string | null;
}

/** What the board menu sends to create or edit one. */
export interface ScheduledCardInput {
  text: string;
  status: ScheduledStatus;
  labels: TaskLabel[];
  cron: string;
  timeZone: string;
  enabled?: boolean;
}
