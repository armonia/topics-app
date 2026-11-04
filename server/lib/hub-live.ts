/**
 * Live hub data on the Topics WebSocket: quotas (`/api/pace`), the Mac
 * (`/api/mac`), the launchd services (`/api/services`), and what the System
 * pane shows: the "waiting for you" items (`/api/attesa`), the firing alerts (allow-italian: hub path)
 * (`/api/alerts`), the quota gates (`/api/gates`) and the automations
 * counters (`/api/automations/summary`).
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

export const HUB_LIVE_TOPICS = ["pace", "mac", "services", "attesa", "alerts", "gates", "automations"] as const;
export type HubLiveTopic = (typeof HUB_LIVE_TOPICS)[number];

/** The hub path each topic reads, under `/api/`. Only `automations` differs
 *  from its name: the full `/api/automations` is close to a megabyte, the
 *  summary is the part a glance needs. */
export const HUB_LIVE_PATHS: Readonly<Record<HubLiveTopic, string>> = {
  pace: "pace",
  mac: "mac",
  services: "services",
  attesa: "attesa",
  alerts: "alerts",
  gates: "gates",
  automations: "automations/summary",
};

export interface HubLiveEntry {
  data?: unknown;
  error?: string;
  at: number;
}

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
      const body = await resp.text();
      JSON.parse(body); // a non-JSON 200 is a broken hub, not data
      return { body };
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

