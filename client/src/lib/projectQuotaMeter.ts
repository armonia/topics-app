/**
 * The project quota meter's reading: how full a project's 24h limit is, and
 * how a number of points is written. Shared by the sidebar row and the
 * Dashboard table, so the two never disagree about when amber turns to red.
 */

/** Where the meter turns amber: the share of the limit already spent. */
export const QUOTA_WARN_SHARE = 0.8;

export type QuotaTone = 'ok' | 'warn' | 'over';

/** `ok` under 80% of the limit, `warn` from 80% to the limit, `over` above it. No limit or no reading is always `ok`. */
export function quotaTone(points: number | null, limit: number | null): QuotaTone {
  if (points === null || limit === null) return 'ok';
  if (points > limit) return 'over';
  if (points >= limit * QUOTA_WARN_SHARE) return 'warn';
  return 'ok';
}

/** Points as a person reads them: one decimal under 10 (`7.5`), whole above, no trailing `.0`. */
export function formatPoints(points: number): string {
  return points < 10 ? String(Math.round(points * 10) / 10) : String(Math.round(points));
}
