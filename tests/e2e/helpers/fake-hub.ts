/**
 * A fake usage hub for the hub specs, on the port the test server is
 * told to look at (`hubPortFor`, `TOPICS_HUB_URL` in `testServerEnv`). It
 * answers the paths the live reader asks (server/lib/hub-live.ts) with trimmed
 * copies of the real hub's shapes, and closes a "waiting for you" item on
 * the close request the way the real hub does (same path and body as
 * `closeWaitingBody` in client/src/lib/hubSystem.ts). It also stands in for
 * the Claude proxy's account log (`activity`, `profiles`: the test server
 * points `TOPICS_SWITCHBOARD_URL` here) and takes «Fix it» (`fix`) and the
 * proxy's token renewal (`refresh`). For the machine's Processes it answers
 * the census (`mac/procs`), the machine list (`machines`) and the proxy's log
 * stream (`logs/stream`, SSE), counting the streams opened and closed.
 * For «Account e quote» it keeps the proxy's accounts, keys and settings as
 * state and applies the proxy's writes (`switch`, `priority`, `account-cap`,
 * `account-enabled`, `remove`, `api-profiles`, `settings`) and the hub's
 * unlock and background stop (`override`, `hold`), so a read after a write
 * shows the change the way the real services do.
 * For «Consumi» in the Dashboard it answers the proxy's raw rows of the week
 * (`token-usage`), the projects' share of the week with their caps (`live`),
 * the queue with Muse's jobs (`queue`) and Muse's tokens (`projects`), and
 * takes a project's new cap (`project-settings`) into the next `live`.
 * `quiet` answers a hub with nothing to say: no item, no failure, every
 * service up. Nothing here ever reaches :3360 or :3335.
 */
import { createServer, type Server } from "node:http";
import { hubPortFor } from "./test-server";

export interface FakeHubItem {
  id: string;
  tipo: "decisione" | "spesa" | "pubblico" | "vista";
  title: string;
  why?: string;
  link?: string | null;
  from?: string;
  due?: number;
  at?: number;
}

export interface FakeHub {
  /** The open items; a close removes from here. */
  items: FakeHubItem[];
  /** Every POST body the hub received, parsed. */
  posts: Array<Record<string, unknown>>;
  /** Pids the census puts in the dev server's unit: a spec hands it a real Topics script's pid. */
  devPids: number[];
  /** The proxy's log streams: opened, and ended by the reader. */
  streams: { opened: number; closed: number };
  /** The Claude proxy's state for «Account e quote»: accounts, reserve keys, settings. */
  proxy: FakeProxy;
  /** The hub's unlocks and background stops in force. */
  overrides: Array<Record<string, unknown>>;
  /** The projects' caps, in % of the week, as `project-settings` writes them. */
  budgets: Record<string, number | null>;
  close(): Promise<void>;
}

const HOUR = 3_600_000;

export interface FakeAccount {
  name: string;
  label: string;
  tier: string;
  isActive: boolean;
  priority: number;
  disabled: boolean;
  expired: boolean;
  fiveH: number | null;
  week: number;
  cap: { fiveH: number | null; sevenD: number | null };
  /** The proxy's last reading of a week that already reset, as the real one keeps for an idle account. */
  weekResetPast?: boolean;
}

export interface FakeProxy {
  accounts: FakeAccount[];
  keys: Array<{ name: string; label: string; priority: number; disabled: boolean }>;
  settings: Record<string, unknown>;
}

/**
 * Four Claude accounts (one in use near its week, one ready, one with its
 * token expired, one switched off whose last week reading is already reset)
 * and two keys. Placeholder names. The hub's `pace` has no row for the
 * switched-off one, as the real hub: the proxy and the hub do not count the
 * same accounts.
 */
export function defaultFakeProxy(): FakeProxy {
  return {
    accounts: [
      { name: "prof-a", label: "lavoro@example.com", tier: "default_claude_max_20x", isActive: true, priority: 0, disabled: false, expired: false, fiveH: 30, week: 92, cap: { fiveH: null, sevenD: null } },
      { name: "prof-b", label: "riserva@example.com", tier: "default_claude_max_5x", isActive: false, priority: 1, disabled: false, expired: false, fiveH: 12, week: 31, cap: { fiveH: null, sevenD: null } },
      { name: "prof-c", label: "terzo@example.com", tier: "default_claude_max_5x", isActive: false, priority: 0, disabled: false, expired: true, fiveH: null, week: 64, cap: { fiveH: null, sevenD: null } },
      { name: "prof-d", label: "spento@example.com", tier: "default_claude_max_5x", isActive: false, priority: 0, disabled: true, expired: false, fiveH: null, week: 100, cap: { fiveH: null, sevenD: null }, weekResetPast: true },
    ],
    keys: [
      { name: "key-acme", label: "Chiave acme-web", priority: 20, disabled: false },
      { name: "key-studio", label: "Chiave studio-x", priority: 10, disabled: true },
    ],
    settings: {
      autoSwitch: true, proxyEnabled: true, rotationStrategy: "margin", rotationIntervalMin: 60, notifications: true, serializeRequests: false,
      maxConcurrentPerAccount: 8, usageCap5h: null, usageCap7d: null, usageCapHoldMin: 10, usdEur: 0.92,
    },
  };
}

/** The proxy's `/api/profiles` from the fake's state, in the real proxy's shape. */
function proxyProfiles(proxy: FakeProxy, now: number): Record<string, unknown> {
  const s = proxy.settings;
  return {
    profiles: proxy.accounts.map((a) => {
      const own = { fiveH: a.cap.fiveH, sevenD: a.cap.sevenD };
      const effective = { fiveH: own.fiveH ?? (s.usageCap5h as number | null), sevenD: own.sevenD ?? (s.usageCap7d as number | null) };
      const over5h = effective.fiveH !== null && a.fiveH !== null && a.fiveH >= effective.fiveH;
      const over7d = effective.sevenD !== null && a.week >= effective.sevenD;
      return {
        name: a.name, label: a.label, subscriptionType: "max", rateLimitTier: a.tier, isActive: a.isActive, priority: a.priority, disabled: a.disabled,
        expiresAt: a.expired ? now - HOUR : now + 30 * 24 * HOUR, expired: false, refreshFailed: a.expired ? { error: "Refresh token expired", retriable: false } : null,
        limited: a.week >= 100, blockKind: a.disabled ? "disabled" : null,
        rateLimits: {
          status: "allowed",
          fiveH: a.fiveH === null ? null : { status: "allowed", utilization: a.fiveH / 100, reset: Math.floor((now + 2 * HOUR) / 1000) },
          sevenD: { status: "allowed", utilization: a.week / 100, reset: Math.floor((now + (a.weekResetPast ? -4 : 3) * 24 * HOUR) / 1000) },
        },
        cap: { override: own, effective: effective, over5h, over7d, over: over5h || over7d, freeAt: 0 },
      };
    }),
    apiProfiles: proxy.keys.map((k) => ({ type: "api", ...k, usage5h: null, usage7d: null, balance: null })),
    allExhausted: false,
    rotationStrategy: s.rotationStrategy,
  };
}

/** The hub's write paths that change the fake's state, and the proxy's. */
const PROXY_WRITES = new Set(["switch", "priority", "account-cap", "account-enabled", "remove", "api-profiles", "settings"]);

function applyProxyWrite(hub: FakeHub, path: string, body: Record<string, unknown>): { status: number; body: unknown } {
  const p = hub.proxy;
  const account = p.accounts.find((a) => a.name === body.name);
  switch (path) {
    case "switch":
      if (!account) return { status: 404, body: { error: "unknown account" } };
      for (const a of p.accounts) a.isActive = a === account;
      // Like the real proxy: a manual switch pins the rotation on sticky.
      p.settings.rotationStrategy = "sticky";
      return { status: 200, body: { ok: true, switched: account.name, strategyChanged: true, strategy: "sticky" } };
    case "priority":
      if (!account || typeof body.priority !== "number") return { status: 400, body: { error: "name and priority" } };
      account.priority = body.priority;
      return { status: 200, body: { ok: true } };
    case "account-cap":
      if (!account) return { status: 404, body: { error: "unknown account" } };
      if ("fiveH" in body) account.cap.fiveH = body.fiveH as number | null;
      if ("sevenD" in body) account.cap.sevenD = body.sevenD as number | null;
      return { status: 200, body: { ok: true } };
    case "account-enabled":
      if (!account) return { status: 404, body: { error: "unknown account" } };
      account.disabled = body.enabled !== true;
      return { status: 200, body: { ok: true } };
    case "remove":
      p.accounts = p.accounts.filter((a) => a.name !== body.name);
      return { status: 200, body: { ok: true } };
    case "api-profiles": {
      const key = p.keys.find((k) => k.name === body.name);
      if (!key) return { status: 404, body: { error: "unknown key" } };
      if (typeof body.priority === "number") key.priority = body.priority;
      if (typeof body.disabled === "boolean") key.disabled = body.disabled;
      return { status: 200, body: { ok: true } };
    }
    default:
      Object.assign(p.settings, body);
      return { status: 200, body: p.settings };
  }
}

export function defaultFakeHubItems(now = Date.now()): FakeHubItem[] {
  return [
    { id: "e2e-decide", tipo: "decisione", title: "Rilasciare Topics 0.48 su stable", why: "il fix è su main", link: "https://example.com/release", from: "guardiano", at: now - 26 * HOUR },
    { id: "e2e-look", tipo: "vista", title: "Slide del corso, lezione 4 sul telefono", from: "sessione corso", due: now + 20 * HOUR, at: now - 3 * HOUR },
    { id: "e2e-spend", tipo: "spesa", title: "Passare studio-x al piano Launch", why: "19 EUR al mese", from: "claude", due: now + 2 * HOUR, at: now - HOUR },
  ];
}

/** A hub with nothing to say: the same paths, every list empty, every service up. */
function quietAnswers(): Record<string, unknown> {
  const now = Date.now();
  return {
    pace: [{ provider: "claude", account: "e2e@example.com", active: true, login: "ok", used: 28, fiveHour: { used: 10, resetsAt: now + HOUR }, status: "ok" }],
    services: { at: now, services: [{ id: "usage-hub", name: "Hub dei consumi", state: "vivo", problem: null }] },
    attesa: { at: now, items: [] },
    alerts: { rules: [], firing: [] },
    "automations/summary": { needsYou: 0, broken: 0, ok: 82, hidden: 0, runsToday: 412 },
    automations: { broken: [] },
    contesto: { contradictions: { at: now - HOUR, items: [] } },
    diario: { at: now, days: 2, items: [] },
    activity: { log: [] },
    profiles: { profiles: [] },
  };
}

function answers(items: FakeHubItem[], devPids: number[] = [], proxy: FakeProxy = defaultFakeProxy(), overrides: Array<Record<string, unknown>> = [], budgets: Record<string, number | null> = defaultFakeBudgets()): Record<string, unknown> {
  const now = Date.now();
  const unlocked = (p: string) => overrides.some((o) => o.provider === p && !o.hold);
  return {
    pace: [
      { provider: "claude", account: "lavoro@example.com", active: true, login: "ok", used: 92, elapsedPct: 55, pace: 1.7, fiveHour: { used: 30, resetsAt: now + HOUR }, status: "ok" },
      { provider: "codex", account: "codex@example.com", active: true, login: "ok", used: 28, elapsedPct: 55, pace: 0.5, resetsAt: now + 3 * 24 * HOUR, fiveHour: { used: 8, resetsAt: now + 2 * HOUR }, status: "ok" },
      { provider: "muse", account: "muse@example.com", active: true, login: "ok", used: 61, elapsedPct: 40, pace: 1.5, resetsAt: now + 4 * 24 * HOUR, fiveHour: null, status: "veloce", quotaStale: false },
    ],
    settings: proxy.settings,
    mac: {
      at: now, cores: 12, strained: false, swapUsedGB: 1.26, swapTotalGB: 8, swapSustained: false,
      effort: { parts: [{ key: "cpu", pct: 34 }, { key: "mem", pct: 60 }] },
      mem: { totalGB: 32, usedGB: 26.8 },
      // Like the real hub: hogs grouped by name, the sum keyed to the first pid
      // (the browser's group of 4 says nothing about pid 2401); trees count their processes.
      hogs: [{ pid: 2001, cpu: 0.18, n: 1 }, { pid: 2101, cpu: 0.04, n: 1 }, { pid: 2401, cpu: 0.3, n: 4 }],
      trees: [{ pid: 2301, cpu: 0.06, n: 1 }, { pid: 4242, cpu: 0.09, n: 1 }],
    },
    "mac/procs": machineCensus(now, devPids),
    machines: machineList(),
    services: { at: now, services: [
      { id: "usage-hub", name: "Hub dei consumi", state: "vivo", port: 3360, mb: 153, problem: null },
      { id: "switchboard", name: "Proxy degli account", state: "vivo", port: 3335, mb: 90, problem: null },
      { id: "openclaw", name: "Gateway di Jarvis", state: "vivo", port: 18789, mb: 2969, problem: null },
      { id: "docs-index", name: "Indice dei documenti", state: "vivo", port: 3342, mb: 95, problem: "non ascolta su :3342" },
      // Switched off on purpose and asleep on demand: neither may reach the bell.
      { id: "openclaw-old", name: "Gateway vecchio", state: "spento", problem: null },
      { id: "free-router", name: "Router dei modelli gratis", state: "in attesa", problem: null },
    ] },
    attesa: { at: now, items },
    alerts: { rules: [], firing: [
      { id: "project:studio-x", subject: "studio-x sopra budget", source: "soglia-progetto", message: "studio-x: 78% della settimana, budget 60%" },
    ] },
    gates: {
      classes: {
        interattivo: { order: ["claude", "codex"], go: true, provider: "claude", account: "lavoro@example.com", reason: "92% usato, ritmo 1,7" },
        gusto: { order: ["claude"], go: true, provider: "claude", account: "lavoro@example.com", reason: "92% usato, ritmo 1,7" },
        massivo: { order: ["free", "muse", "codex", "claude"], go: true, provider: "free", account: null, reason: "canali gratis, nessuna quota" },
        batch: { order: ["free", "muse", "codex", "claude"], go: false, provider: null, account: null, reason: "Muse sopra ritmo, Codex in pari" },
      },
      brakes: { muse: { go: unlocked("muse") }, codex: { go: true } },
      providers: {
        claude: { state: "libero", reason: "92% usato", waitUntil: null },
        codex: { state: "libero", reason: "28% usato, ritmo 0,5", waitUntil: null },
        muse: unlocked("muse") ? { state: "libero", reason: "sbloccato da Topics", waitUntil: null } : { state: "frenato", reason: "consuma 1,5 volte il previsto per la settimana", waitUntil: now + 6 * HOUR },
      },
      overrides,
      reserve: 10,
    },
    "automations/summary": { needsYou: 0, broken: 1, ok: 81, hidden: 0, runsToday: 412, calendar: { count: 3, next: { title: "Backup of the Mac", at: now + HOUR } } },
    automations: { broken: [{ key: "gh:docs-reindex", title: "Reindex dell'indice documenti", reason: "ha fallito alle 21:26", last: { at: now - HOUR, outcome: "error" } }] },
    contesto: { contradictions: { at: now - HOUR, items: [{ a: { file: "~/rules-a.md", text: "x" }, b: { file: "~/rules-b.md", text: "y" }, why: "una chiede i commenti in inglese, l'altra in italiano" }] } },
    diario: { at: now, days: 2, items: [
      { at: now - 30 * 60_000, kind: "auto", who: "Mac", title: "Backup del Mac", outcome: "ok", what: "1,2 GB in 4 min" },
      { at: now - 40 * 60_000, kind: "auto", who: "OpenClaw", title: "Brief del mattino", outcome: "skipped", what: "" },
      { at: now - 50 * 60_000, kind: "auto", who: "GitHub", title: "Reindex dell'indice documenti", outcome: "error", what: "uscito con codice 1" },
      { at: now - 70 * 60_000, kind: "agente", who: "Agente · Muse", title: "Un agente ha sistemato il reindex", outcome: "ok", what: "progetto acme-web" },
      { at: now - 90 * 60_000, kind: "workflow", who: "Workflow", title: "Audit delle dipendenze", outcome: "ok", what: "2 agenti, 6 min" },
    ] },
    activity: { log: [
      { type: "auto-switch", ts: now - 40 * 60_000, from: "prof-a", to: "prof-b", reason: "429" },
      { type: "auth-expired", ts: now - 2 * HOUR, account: "prof-c" },
      { type: "upstream-retry", ts: now - 10 * 60_000, account: "prof-a", status: 529 },
    ] },
    profiles: proxyProfiles(proxy, now),
    "token-usage": proxyRows(now),
    live: { at: now, projects: liveProjects(budgets) },
    queue: { items: [
      { id: "q1", provider: "muse", project: "acme-web", status: "done", createdAt: now - 2 * HOUR },
      { id: "q2", provider: "muse", project: "studio-x", status: "done", createdAt: now - 26 * HOUR },
      { id: "q3", provider: "muse", project: "acme-api", status: "running", createdAt: now - 10 * 60_000 },
      { id: "q4", provider: "codex", project: "acme-web", status: "done", createdAt: now - 3 * HOUR },
      { id: "q5", provider: "muse", project: "acme-web", status: "done", createdAt: now - 20 * 24 * HOUR },
    ] },
    projects: { muse: { projects: [{ name: "acme-web", tokens: 6_000_000 }, { name: "studio-x", tokens: 3_100_000 }] } },
  };
}

/** The caps the fixture starts from: studio-x is past its own. */
export function defaultFakeBudgets(): Record<string, number | null> {
  return { "acme-web": 40, "studio-x": 25 };
}

/** The hub's live projects: share of the week per provider and the cap; six of them, so two fall in the rest. */
function liveProjects(budgets: Record<string, number | null>): unknown[] {
  const row = (name: string, claude: number, codex: number, muse: number) =>
    ({ name, title: name, label: null, claude, codex, muse, total: Math.round((claude + codex + muse) * 10) / 10, budgetPct: budgets[name] ?? null, state: "attivo", why: "" });
  return [row("acme-web", 30, 2, 6), row("studio-x", 20, 0, 7), row("acme-api", 10, 1, 3), row("acme-docs", 5, 0, 1), row("misc-a", 2, 0, 0), row("misc-b", 1, 0, 0)];
}

/**
 * The Claude proxy's raw rows of the week, in its shape: per day two Opus 5.5
 * rows, one Sonnet 5.5 and one Haiku 5.5, on two accounts. Each row is a minute
 * before `now` minus whole days, so it is always inside the window.
 */
function proxyRows(now: number): unknown[] {
  const rows: unknown[] = [];
  const r = (ts: number, model: string, account: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number) =>
    ({ ts, repo: "/w/acme-web", branch: "main", model, account, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cwd: "/w/acme-web" });
  for (let d = 0; d < 7; d++) {
    const ts = now - d * 24 * HOUR - 60_000;
    const swing = 1 + (d % 3) * 0.25;
    rows.push(r(ts, "claude-opus-5-5", "lavoro@example.com", 4_000, Math.round(900_000 * swing), 60_000_000, 1_200_000));
    rows.push(r(ts - 1000, "claude-opus-5-5", "riserva@example.com", 2_000, 400_000, 30_000_000, 500_000));
    rows.push(r(ts - 2000, "claude-sonnet-5-5", "lavoro@example.com", 3_000, Math.round(600_000 * swing), 40_000_000, 800_000));
    rows.push(r(ts - 3000, "claude-haiku-5-5", "lavoro@example.com", 2_000, 300_000, 10_000_000, 300_000));
  }
  return rows;
}

/**
 * The census of the machine's Processes: GPU and network measured on most
 * units and not on two (`gpuPct`/`net*` null), and the dev server whose pids
 * a spec sets to a real Topics script's (`FakeHub.devPids`). Placeholder names.
 */
const DEV_SERVER_PID = 4242;

function machineCensus(now: number, devPids: number[]): Record<string, unknown> {
  const unit = (id: string, name: string, type: string, memMB: number, gpuPct: number | null, netIn: number | null, netOut: number | null, pids: number[], use: string) =>
    ({ id, name, type, memMB, gpuPct, netInBps: netIn, netOutBps: netOut, pids, n: pids.length, use: { text: use }, owner: { label: "la apri tu" } });
  const units = [
    unit("servizio:gw", "Gateway di Jarvis", "servizio", 2969, 0, 14_336, 6_144, [2101], "2 connessioni attive"),
    unit("app:topics", "Topics", "app", 2458, 12, 122_880, 40_960, [2001, 2002], "ponte terminali, 4 webview"),
    unit("devserver:vite", "Server di sviluppo · vite :5173 · acme-web", "devserver", 1638, 0, 8_192, 2_048, [DEV_SERVER_PID, ...devPids], "1 client collegato"),
    unit("sessione:claude", "Claude · 3 sessioni", "sessione", 1126, 0, 317_440, 97_280, [2301], "aperta da 2 h"),
    unit("app:browser", "Browser", "app", 980, 21, 1_887_437, 30_720, [2401], "usata 3,4 h in 14 giorni"),
    unit("altro:containers", "Container locali", "altro", 870, 0, 2_048, 1_024, [2501], "postgres, redis"),
    unit("macos", "macOS", "macos", 510, 30, null, null, [1], "lo gestisce macOS"),
    unit("altro:gpu-helper", "WebKit · GPU", "altro", 320, null, null, null, [2601], "nessuna connessione"),
    ...Array.from({ length: 6 }, (_, i) => unit(`app:small-${i}`, `Strumento ${i + 1}`, "app", 120 - i * 10, 0, 0, 0, [3000 + i], "usata 0,1 h in 14 giorni")),
  ];
  return { at: now - 2_000, units, summary: { processes: 640, units: units.length, memMB: 11_900, gpuNetWindowS: 3, netInBps: 2_411_724, netOutBps: 178_176 } };
}

/** A day of samples, one every 15 min, as the hub's `history` ({t: unix s, v: %}); swap has none, like the real hub. */
function day(base: number, swing: number, last: number): Array<{ t: number; v: number }> {
  const end = Math.floor(Date.now() / 1000);
  return Array.from({ length: 96 }, (_, i) => ({
    t: end - (95 - i) * 900,
    v: i === 95 ? last : Math.max(0, Math.min(100, Math.round(base + swing * Math.sin(i / 7)))),
  }));
}

function machineList(): unknown[] {
  return [
    { id: "local", name: "Mac", local: true, state: "tranquillo", level: 0, caption: "12 core · ultime 24 h",
      metrics: [{ key: "cpu", name: "CPU", pct: 31, history: day(45, 30, 31) }, { key: "mem", name: "Memoria", pct: 62, history: day(60, 10, 62) }, { key: "swap", name: "Swap", pct: 15, history: [] }, { key: "gpu", name: "GPU", pct: 38, history: day(30, 25, 38) }, { key: "disk", name: "Disco", pct: 70, history: day(70, 1, 70) }] },
    { id: "pc", name: "PC", local: false, state: "lavora", level: 0, caption: "dorme dopo 20 min senza lavoro",
      lines: ["Collegato dal Mac", "Suite e2e di acme-web, mandata dal Mac carico"],
      metrics: [{ key: "cpu", name: "CPU", pct: 25, note: "adesso", history: day(30, 25, 25), window: 86400 }, { key: "mem", name: "Memoria", pct: 67, note: "adesso", history: day(60, 12, 67), window: 86400 }, { key: "gpu", name: "GPU", pct: 4, note: "adesso", history: day(10, 10, 4), window: 86400 }, { key: "disk", name: "Disco", pct: 92, note: "78,0 GB liberi", history: day(92, 0, 92), window: 86400 }],
      procs: [{ name: "chrome-headless-shell", cores: 1.2 }], offload: 2 },
  ];
}

const LOG_LINES = [
  { ts: "14:04:57", tag: "freno", msg: "studio-x al 70% della settimana, ritmo ridotto" },
  { ts: "14:05:12", tag: "200", msg: "muse · acme-api -> quota fissa · 2,1 s" },
  { ts: "14:05:30", tag: "200", msg: "claude · board -> account principale · 0,8 s" },
  { ts: "14:05:41", tag: "429", msg: "limite del provider, ritento fra 20 s" },
  { ts: "14:05:58", tag: "200", msg: "codex · studio-x -> account lavoro · 3,4 s" },
  { ts: "14:06:09", tag: "rotation", msg: "secondo account al 91% della 5h, passa al terzo" },
  { ts: "14:06:12", tag: "200", msg: "claude · acme-web -> account principale · 1,2 s" },
];

export async function startFakeHub(items: FakeHubItem[] = defaultFakeHubItems(), opts: { quiet?: boolean } = {}): Promise<FakeHub> {
  const hub: FakeHub = { items, posts: [], devPids: [], streams: { opened: 0, closed: 0 }, proxy: defaultFakeProxy(), overrides: [], budgets: defaultFakeBudgets(), close: async () => {} };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!.replace(/^\/api\//, "");
    if (req.method === "GET" && path === "logs/stream") {
      hub.streams.opened++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ tag: "system", msg: "Connected to log stream" })}\n\n`);
      for (const l of LOG_LINES) res.write(`data: ${JSON.stringify(l)}\n\n`);
      const beat = setInterval(() => res.write(": beat\n\n"), 1000);
      res.on("close", () => { clearInterval(beat); hub.streams.closed++; });
      return;
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && path === "attesa") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push(body);
        if (body.kind !== "chiudi" || typeof body.ref !== "string") return send(400, { error: "kind chiudi and ref required" });
        hub.items = hub.items.filter((i) => i.id !== body.ref);
        send(200, { ok: true });
      });
      return;
    }
    // The proxy's writes and the hub's unlock and background stop: applied to the state the reads answer from.
    if ((req.method === "POST" || req.method === "PATCH") && PROXY_WRITES.has(path)) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push({ path, ...body });
        const r = applyProxyWrite(hub, path, body);
        send(r.status, r.body);
      });
      return;
    }
    if ((path === "override" || path === "hold") && (req.method === "POST" || req.method === "DELETE")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const hold = path === "hold";
        if (req.method === "DELETE") {
          const provider = new URL(req.url ?? "", "http://x").searchParams.get("provider");
          hub.posts.push({ path, method: "DELETE", ...(provider ? { provider } : {}) });
          const before = hub.overrides.length;
          hub.overrides = hub.overrides.filter((o) => (hold ? !o.hold : !(o.provider === provider && !o.hold)));
          return send(200, { removed: before - hub.overrides.length });
        }
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push({ path, ...body });
        const now = Date.now();
        const o = hold
          ? { provider: "*", hold: true, class: null, by: body.by, reason: body.reason, since: now, until: now + Number(body.hours) * HOUR }
          : { provider: body.provider, class: null, by: body.by, reason: body.reason, since: now, until: now + Number(body.hours) * HOUR };
        hub.overrides = hub.overrides.filter((x) => (hold ? !x.hold : x.provider !== o.provider)).concat(o);
        send(200, o);
      });
      return;
    }
    // A project's cap, as the tray and the Dashboard write it: {name, budgetPct}.
    if (req.method === "POST" && path === "project-settings") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push({ path, ...body });
        if (typeof body.name !== "string") return send(400, { error: "nome progetto mancante" });
        hub.budgets[body.name] = typeof body.budgetPct === "number" ? body.budgetPct : null;
        send(200, { ok: true, name: body.name, saved: { budgetPct: body.budgetPct } });
      });
      return;
    }
    if (req.method === "POST" && (path === "fix" || path === "refresh")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push({ path, ...body });
        send(200, path === "fix" ? { ok: true, item: { id: "e2e-fix", status: "queued" } } : { ok: true });
      });
      return;
    }
    // A retry must start from the default items, and the Topics live reader
    // must see them at once: a write through the Topics proxy is read back
    // before it answers (server/routes/hub.ts), so the reset goes that way.
    if (req.method === "POST" && path === "e2e-reset") {
      hub.items = defaultFakeHubItems();
      hub.posts.length = 0;
      hub.proxy = defaultFakeProxy();
      hub.overrides = [];
      hub.budgets = defaultFakeBudgets();
      req.resume();
      return send(200, { ok: true });
    }
    const all = opts.quiet ? quietAnswers() : answers(hub.items, hub.devPids, hub.proxy, hub.overrides, hub.budgets);
    if (req.method === "GET" && path in all) return send(200, all[path]);
    send(404, { error: "not in the fake hub" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(hubPortFor(), "127.0.0.1", () => resolve());
  });
  // An open log stream would hold `close` forever: the connections go first.
  hub.close = () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return hub;
}
