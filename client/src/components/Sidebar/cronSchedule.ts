/**
 * A cron job's schedule, as the gateway's compact list view sends it.
 *
 * Its own module for the same reason as `cronRefusal.ts`: a second export in
 * `CronJobsPanel.tsx` would cost Fast Refresh on every edit of the panel.
 */
export interface CronSchedule {
  kind: 'at' | 'every' | 'cron';
  /** ISO date: the gateway's shape for `at`. `atMs` is the older one. */
  at?: string;
  atMs?: number;
  everyMs?: number;
  expr?: string;
  tz?: string;
  anchorMs?: number;
}

/** The schedule in a few characters; '-' when there is none to show (event-driven jobs carry no schedule). */
export function formatSchedule(schedule: CronSchedule | undefined): string {
  if (!schedule) return '-';
  const atMs = schedule.atMs ?? (schedule.at ? Date.parse(schedule.at) : NaN);
  if (schedule.kind === 'at' && Number.isFinite(atMs)) {
    const date = new Date(atMs);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    const mins = Math.round(schedule.everyMs / 60000);
    if (mins < 60) return `every ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `every ${hours}h`;
    return `every ${Math.round(hours / 24)}d`;
  }
  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.expr;
  }
  return '-';
}
