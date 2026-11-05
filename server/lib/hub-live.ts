/**
 * Live hub data on the Topics WebSocket: quotas (`/api/pace`), the Mac
 * (`/api/mac`), the launchd services (`/api/services`), and what the System
 * pane shows: the "waiting for you" items (`/api/attesa`), the firing alerts (allow-italian: hub path)
 * (`/api/alerts`), the quota gates (`/api/gates`) and the automations
 * counters (`/api/automations/summary`), and the projects' state, share of
 * the week, cap and priority (`/api/live`) for the sidebar's project row.
 *
 * The hub's own pages poll every 60 s, each tab on its own. Here ONE reader
 * (this server) asks the hub and pushes a `hub:live` frame only when the
 * answer changed, so N open windows cost one request per tick and no client
 * polls. The reader runs only while a window is connected: with nobody
 * watching, Topics does not knock on the hub at all.
 *
 * An unreachable hub is a frame too (`error`, once per transition), so a panel
 * can say "hub down" instead of keeping numbers that stopped being true.
 */

import { HUB_LIVE_TOPICS, type HubLiveTopic, type HubLiveEntry } from "../../shared/hub-live";
export { HUB_LIVE_TOPICS };
export type { HubLiveTopic, HubLiveEntry };

/** The hub path each topic reads, under `/api/`. Two differ from their
 *  names. `automations`: the full `/api/automations` is close to a megabyte, the
 *  summary is the part a glance needs; `projects` reads `/api/live`, the
 *  projects with their state and their share of the week. */
export const HUB_LIVE_PATHS: Readonly<Record<HubLiveTopic, string>> = {
  pace: "pace",
  mac: "mac",
  services: "services",
  attesa: "attesa",
  alerts: "alerts",
  gates: "gates",
  automations: "automations/summary",
  projects: "live",
};

/**
 * What the reader keeps of a topic's answer, where it is not the whole of it.
 * The hub's `/api/live` carries each project's live agents and the time it was
 * last seen, which change on every read: pushed whole, it would be a frame per
 * tick to every window. The sidebar's project row reads only the fields below,
 * so a frame goes out only when one of them changed. `dir` stays out too: it
 * is the folder of whichever agent ran last, so it moves on its own.
 */
const PROJECT_FIELDS = ["name", "title", "state", "why", "waitUntil", "budgetPct", "priority", "total"] as const;

function pickLiveProjects(data: unknown): unknown {
  const list = (data as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return { projects: [] };
  const projects = list.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const row = p as Record<string, unknown>;
    return [Object.fromEntries(PROJECT_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]))];
  });
  return { projects };
}

const HUB_LIVE_SHAPES: Partial<Record<HubLiveTopic, (data: unknown) => unknown>> = {
  projects: pickLiveProjects,
};

export type HubLiveFrame = {
  type: "hub:live";
  topic: HubLiveTopic;
  data?: unknown;
  error?: string;
  at: number;
};

export interface HubLiveDeps {
  base: () => string | null;
  broadcast: (frame: HubLiveFrame) => void;
  hasClients: () => boolean;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export const HUB_LIVE_INTERVAL_MS = 15_000;

export function createHubLive(deps: HubLiveDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const intervalMs = deps.intervalMs ?? HUB_LIVE_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const now = deps.now ?? Date.now;
  const last = new Map<HubLiveTopic, { body: string | null; error: string | null; entry: HubLiveEntry }>();
  let lastTickAt = Number.NEGATIVE_INFINITY; // never read: the first snapshot must read
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function readTopic(base: string, topic: HubLiveTopic): Promise<{ body: string } | { error: string }> {
    try {
      const path = HUB_LIVE_PATHS[topic];
      const resp = await fetchImpl(`${base}/api/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) return { error: `hub answered ${resp.status} on /api/${path}` };
      const raw = await resp.text();
      const parsed: unknown = JSON.parse(raw); // a non-JSON 200 is a broken hub, not data
      const shape = HUB_LIVE_SHAPES[topic];
      return { body: shape ? JSON.stringify(shape(parsed)) : raw };
    } catch (err) {
      return { error: `hub not reachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async function runTick(): Promise<void> {
    const base = deps.base();
    if (!base) return;
    lastTickAt = now();
    const results = await Promise.all(HUB_LIVE_TOPICS.map(async (t) => [t, await readTopic(base, t)] as const));
    for (const [topic, r] of results) {
      const prev = last.get(topic);
      const at = now();
      if ("body" in r) {
        if (prev?.body === r.body) { prev.entry.at = at; continue; }
        const entry: HubLiveEntry = { data: JSON.parse(r.body), at };
        last.set(topic, { body: r.body, error: null, entry });
        deps.broadcast({ type: "hub:live", topic, data: entry.data, at });
      } else {
        if (prev?.error === r.error) continue;
        // The last good numbers are dropped: a panel must not show them as current.
        const entry: HubLiveEntry = { error: r.error, at };
        last.set(topic, { body: null, error: r.error, entry });
        deps.broadcast({ type: "hub:live", topic, error: r.error, at });
      }
    }
  }

  /** One read of every topic; concurrent callers share it. */
  function tick(): Promise<void> {
    if (!inFlight) inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * A read that starts AFTER the caller's write. A tick already in flight may
   * have asked the hub before the write landed, so sharing it would push the
   * old list again: wait for it, then read anew.
   */
  async function refresh(): Promise<void> {
    if (inFlight) await inFlight;
    await tick();
  }

  return {
    tick,
    refresh,
    /** The last known state per topic, refreshed first if older than a tick,
     *  or if a topic was unreadable last time: a window opening after the hub
     *  came back must not wait a whole interval to see it. */
    async snapshot(): Promise<Partial<Record<HubLiveTopic, HubLiveEntry>>> {
      const anyError = [...last.values()].some((v) => v.error !== null);
      if (now() - lastTickAt >= intervalMs || anyError) await tick();
      return Object.fromEntries([...last].map(([t, v]) => [t, v.entry]));
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => { if (deps.hasClients()) void tick(); }, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

