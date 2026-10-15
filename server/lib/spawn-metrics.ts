/** Conteggi dei processi periodici lanciati dal server, ultimi 15 minuti. */
export type SpawnMetricKind = "gitStatus" | "gitFetch" | "lsof" | "vmStat" | "other";
export type SpawnMetricCause = string;

const WINDOW_MS = 15 * 60_000;
const events: { at: number; kind: SpawnMetricKind; cause: SpawnMetricCause }[] = [];

export function recordServerSpawn(kind: SpawnMetricKind, cause: SpawnMetricCause, now = Date.now()): void {
  events.push({ at: now, kind, cause });
  prune(now);
}

function prune(now: number): void {
  const oldest = now - WINDOW_MS;
  let keep = 0;
  for (const event of events) if (event.at >= oldest) events[keep++] = event;
  events.length = keep;
}

export function serverSpawnCounts(now = Date.now()) {
  prune(now);
  const counts: Record<SpawnMetricKind, Record<string, number>> = {
    gitStatus: {}, gitFetch: {}, lsof: {}, vmStat: {}, other: {},
  };
  for (const event of events) counts[event.kind][event.cause] = (counts[event.kind][event.cause] ?? 0) + 1;
  return { windowMinutes: 15, sampledAt: new Date(now).toISOString(), counts };
}
