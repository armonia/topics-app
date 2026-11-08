/**
 * A GROUPING parent: a backlog card no turn ever touched (no attempt, never
 * started, never delivered, no dispatch chip) that has open children. It is a
 * person grouping cards under it, not work of its own, so the Plan keeps it out
 * of its counts and does not flag it «no owner».
 *
 * The same predicate as the NOT(...) of `PARKED_CHILDREN_CANDIDATES_SQL`
 * (server/lib/task-timer-reads.ts), which spares these parents from the parked
 * sweep. The test runs both on one DB, so the two cannot drift apart.
 */
export interface GroupingParentFields {
  status: string;
  dispatch_attempts?: number | null;
  in_progress_at?: string | null;
  delivered_by?: string | null;
  dispatch_state?: string | null;
}

export function isGroupingParent(t: GroupingParentFields, openChildren: number): boolean {
  return openChildren > 0
    && t.status === "backlog"
    && (t.dispatch_attempts ?? 0) === 0
    && t.in_progress_at == null
    && t.delivered_by == null
    && t.dispatch_state == null;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
