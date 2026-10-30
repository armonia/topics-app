export const DISPATCH_MEMORY_HISTORY_CADENCE_MS = 60_000;
export const DISPATCH_MEMORY_HISTORY_WINDOW_MS = 2 * 60 * 60_000;

const MAX_DISPATCH_MEMORY_HISTORY_POINTS =
  Math.floor(DISPATCH_MEMORY_HISTORY_WINDOW_MS / DISPATCH_MEMORY_HISTORY_CADENCE_MS) + 1;

export type DispatchMemoryHistoryPoint = {
  at: number;
  freeGB: number;
  /** Cards working at that minute, when the dispatcher could say (the chart's lower strip). */
  running?: number;
};

/** Keeps bounded, process-local memory readings for the dispatch dashboard. */
export function createDispatchMemoryHistory() {
  const points: DispatchMemoryHistoryPoint[] = [];

  return {
    /** Records at most one reading per cadence and drops readings older than two hours. */
    record(at: number, freeGB: number, running?: number): boolean {
      if (!Number.isFinite(at) || !Number.isFinite(freeGB) || freeGB < 0) return false;

      const last = points.at(-1);
      if (last && at - last.at < DISPATCH_MEMORY_HISTORY_CADENCE_MS) return false;

      const cutoff = at - DISPATCH_MEMORY_HISTORY_WINDOW_MS;
      while (points.length > 0 && points[0]!.at < cutoff) points.shift();

      points.push(running === undefined ? { at, freeGB } : { at, freeGB, running });
      while (points.length > MAX_DISPATCH_MEMORY_HISTORY_POINTS) points.shift();
      return true;
    },

    /** Returns a fresh, bounded snapshot even when the sampler has stopped. */
    read(now = Date.now()): DispatchMemoryHistoryPoint[] {
      const cutoff = now - DISPATCH_MEMORY_HISTORY_WINDOW_MS;
      while (points.length > 0 && points[0]!.at < cutoff) points.shift();
      return points.map((point) => ({ ...point }));
    },
  };
}
