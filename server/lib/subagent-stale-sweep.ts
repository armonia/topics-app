/**
 * Results that stay owed to a parent chat for 15 minutes are delivered again.
 * A wake that died with its card unwritten (a failed write, a lost queue entry)
 * left the child "about to resume" for good until the next restart. The wake
 * ignores a result still genuinely queued, so asking twice is harmless.
 */
import { allPendingResults } from "./subagent-store";
import { resultKey, type SubAgentResult } from "./subagent-result";

const STALE_RESULT_MS = 15 * 60_000;
const STALE_SWEEP_MS = 60_000;
const firstSeen = new Map<string, number>();
let lastSweep = 0;

type Db = Parameters<typeof allPendingResults>[0];

export function sweepStaleResults(
  db: Db,
  deliver: (r: SubAgentResult, exitCode: number | null, parentKey: string) => void,
  now = Date.now(),
): number {
  if (now - lastSweep < STALE_SWEEP_MS) return 0;
  lastSweep = now;
  const owed = new Set<string>();
  let asked = 0;
  for (const { row, results } of allPendingResults(db)) {
    for (const r of results) {
      const key = resultKey(r);
      owed.add(key);
      const since = firstSeen.get(key) ?? now;
      firstSeen.set(key, since);
      if (now - since < STALE_RESULT_MS) continue;
      firstSeen.set(key, now);
      deliver(r, null, row.parentSessionKey);
      asked++;
    }
  }
  for (const key of firstSeen.keys()) if (!owed.has(key)) firstSeen.delete(key);
  return asked;
}

/** Test seam: forget what the sweep has seen. */
export function resetStaleSweep(): void {
  firstSeen.clear();
  lastSweep = 0;
}
