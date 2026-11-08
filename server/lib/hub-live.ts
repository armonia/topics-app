/**
 * Live hub data on the Topics WebSocket: quotas (`/api/pace`), the Mac
 * (`/api/mac`), the launchd services (`/api/services`), and what the System
 * pane shows: the "waiting for you" items (`/api/attesa`), the firing alerts (allow-italian: hub path)
 * (`/api/alerts`), the quota gates (`/api/gates`) and the automations
 * counters (`/api/automations/summary`), the projects' state, share of
 * the week, cap, priority and live agents (`/api/live`) for the sidebar's
 * project row and its menu, and for the bell the quota forecast
 * (`/api/forecast`: which subscription runs out before its reset at today's
 * pace) and whether the PC answers (`/api/pc`).
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
  forecast: "forecast",
  pc: "pc",
};

/**
 * Topics read once every N ticks instead of every tick. `services` costs the
 * hub about 5 CPU-seconds a snapshot and it caches it for 60 s, so a read every
 * 15 s kept it recomputing all day while nobody looked (its own page computed it
 * only with the tab open); a stopped service in the bell a minute later is
 * soon enough. `pc` is rewritten by its watcher once a minute.
 */
export const HUB_LIVE_EVERY: Readonly<Partial<Record<HubLiveTopic, number>>> = { services: 4, pc: 4 };

/**
 * What the reader keeps of a topic's answer, where it is not the whole of it.
 * The hub's `/api/live` carries each project's live agents and the time it was
 * last seen, which change on every read: pushed whole, it would be a frame per
 * tick to every window. The sidebar's project row and menu read the fields
 * below, and the moving ones are coarsened (`shapeAgents`, `minute`) so a frame
 * goes out when something a reader can see changed, about once a minute while
 * agents work. `dir` stays out: it is the folder of whichever agent ran last,
 * so it moves on its own.
 */
const PROJECT_FIELDS = [
  "name", "title", "what", "state", "why", "brake", "waitUntil", "budgetPct", "priority", "total", "claude", "codex", "muse", "dirMissing",
] as const;

/** Agents listed per project: the menu shows a handful, the count says the rest. */
const AGENTS_LISTED = 12;

/** A time to the minute: what the menu says («3 min fa») moves no faster. */
const minute = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v / 60_000) * 60_000 : null);

/** A count to two significant digits: «786 k token» does not change with every request. */
function twoDigits(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  const scale = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / scale) * scale;
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The safe part of an agent's way in: a link the app opens, and where it opens. */
function openOf(v: unknown): { url: string; via: string } | null {
  const o = v as { url?: unknown; via?: unknown } | null;
  return o && typeof o.url === "string" && /^(https?|claude):\/\//.test(o.url) ? { url: o.url, via: typeof o.via === "string" ? o.via : "" } : null;
}

/**
 * The live agents of a project as the menu reads them: how many, the model
 * mix, the Opus count and time (for the cost advice), the tokens of the last
 * hour summed (the project's pace), and the first agents with what the menu
 * prints of each. Every moving number is coarsened, see PROJECT_FIELDS.
 */
function shapeAgents(data: unknown): unknown {
  const a = data as { count?: unknown; models?: unknown; opus?: unknown; opusMs?: unknown; list?: unknown } | null;
  if (!a || typeof a !== "object" || typeof a.count !== "number" || a.count <= 0) return null;
  const list = Array.isArray(a.list) ? a.list.filter((g): g is Record<string, unknown> => !!g && typeof g === "object") : [];
  const use = (g: Record<string, unknown>) => (g.use && typeof g.use === "object" ? (g.use as Record<string, unknown>) : {});
  return {
    count: a.count,
    models: Array.isArray(a.models)
      ? a.models.flatMap((m) => (m && typeof m === "object" && typeof (m as { n?: unknown }).n === "number"
        ? [{ provider: text((m as { provider?: unknown }).provider) ?? "", model: text((m as { model?: unknown }).model) ?? "", n: (m as { n: number }).n }]
        : []))
      : [],
    opus: typeof a.opus === "number" ? a.opus : 0,
    opusMs: minute(a.opusMs) ?? 0,
    hourTokens: twoDigits(list.reduce((t, g) => t + (typeof use(g).hourTokens === "number" ? (use(g).hourTokens as number) : 0), 0)),
    list: list.slice(0, AGENTS_LISTED).map((g) => ({
      provider: text(g.provider) ?? "",
      model: text(g.model) ?? "",
      kind: text(g.kind) ?? "",
      depth: typeof g.depth === "number" ? g.depth : 0,
      title: text(g.work) ?? text(g.title) ?? "",
      startedAt: minute(g.startedAt),
      lastActivity: minute(g.lastActivity),
      tokens: twoDigits(use(g).tokens),
      pct: typeof use(g).pct === "number" ? Math.round((use(g).pct as number) * 10) / 10 : 0,
      open: openOf(g.open),
    })),
  };
}

/** The hub's word for an agent it found in a Topics tab (`open.via`). */
const IN_TOPICS_TAB = "tab Topics"; // allow-italian: the hub's wire value

/**
 * How many agents the hub sees at work outside Topics: every live agent of
 * every project (Claude Code, Codex, Muse, their sub-agents and workflow
 * agents), less the ones it found in a Topics tab, which Topics counts itself.
 * A number, not the list: it moves only when an agent starts or stops.
 */
export function agentsOutsideTopics(list: unknown[]): number {
  let n = 0;
  for (const p of list) {
    const agents = (p as { agents?: { list?: unknown } } | null)?.agents?.list;
    if (!Array.isArray(agents)) continue;
    for (const a of agents) {
      const via = (a as { open?: { via?: unknown } } | null)?.open?.via;
      if (a && typeof a === "object" && via !== IN_TOPICS_TAB) n++;
    }
  }
  return n;
}

function pickLiveProjects(data: unknown): unknown {
  const list = (data as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return { projects: [] };
  const projects = list.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const row = p as Record<string, unknown>;
    const out: Record<string, unknown> = Object.fromEntries(PROJECT_FIELDS.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
    const seen = row.lastSeen as { at?: unknown; provider?: unknown } | null | undefined;
    if (seen && minute(seen.at) !== null) out.lastSeen = { at: minute(seen.at), provider: text(seen.provider) ?? "" };
    const agents = shapeAgents(row.agents);
    if (agents) out.agents = agents;
    return [out];
  });
  return { projects, agentsOutside: agentsOutsideTopics(list) };
}

const DAY_MS = 86_400_000;

/**
 * The forecast without what moves on every read: `at`, and the exact minute a
 * quota runs out (it drifts with the pace). The sentence keeps the time the
 * hub writes, so a frame goes out when that sentence changes; `soon` (runs out
 * within a day) is what makes the hub paint it red.
 */
function pickForecast(data: unknown): unknown {
  const d = (data && typeof data === "object" ? data : {}) as { at?: unknown; providers?: unknown };
  const at = typeof d.at === "number" ? d.at : Date.now();
  const list = Array.isArray(d.providers) ? d.providers : [];
  const providers = list.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const row = p as Record<string, unknown>;
    const out = typeof row.runsOutAt === "number" ? row.runsOutAt : null;
    return [{ id: row.id, status: row.status, level: row.level ?? 0, right: row.right, sub: row.sub, soon: out !== null && out - at < DAY_MS }];
  });
  return { providers };
}

/** The PC's state alone: its «why» carries a minute counter that would push a frame every read. */
function pickPc(data: unknown): unknown {
  const pc = (data as { pc?: unknown } | null)?.pc;
  return { pc: typeof pc === "string" ? pc : null };
}

const HUB_LIVE_SHAPES: Partial<Record<HubLiveTopic, (data: unknown) => unknown>> = {
  projects: pickLiveProjects,
  forecast: pickForecast,
  pc: pickPc,
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
  let ticks = 0;
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

  /** Due this tick: every topic on a forced read, one never read or unreadable last time, or its turn. */
  const isDue = (topic: HubLiveTopic, tick: number, all: boolean): boolean => {
    const every = HUB_LIVE_EVERY[topic] ?? 1;
    const prev = last.get(topic);
    return all || every <= 1 || !prev || prev.error !== null || tick % every === 0;
  };

  async function runTick(all: boolean): Promise<void> {
    const base = deps.base();
    if (!base) return;
    lastTickAt = now();
    const tick = ticks++;
    const due = HUB_LIVE_TOPICS.filter((t) => isDue(t, tick, all));
    const results: Array<readonly [HubLiveTopic, { body: string } | { error: string }]> = await Promise.all(due.map(async (t) => [t, await readTopic(base, t)] as const));
    // A hub that answers none of the topics read is down for the skipped ones too:
    // their numbers must not outlive it until their turn comes.
    const down = results.length > 0 && results.every(([, r]) => "error" in r) ? (results[0]![1] as { error: string }).error : null;
    if (down) for (const t of HUB_LIVE_TOPICS) if (!due.includes(t) && last.has(t)) results.push([t, { error: down }]);
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

  /** One read of the topics due (every topic when `all`); concurrent callers share it. */
  function tick(all = false): Promise<void> {
    if (!inFlight) inFlight = runTick(all).finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * A read that starts AFTER the caller's write. A tick already in flight may
   * have asked the hub before the write landed, so sharing it would push the
   * old list again: wait for it, then read anew, every topic.
   */
  async function refresh(): Promise<void> {
    if (inFlight) await inFlight;
    await tick(true);
  }

  return {
    tick: () => tick(),
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

export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
