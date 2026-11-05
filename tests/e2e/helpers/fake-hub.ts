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
  close(): Promise<void>;
}

const HOUR = 3_600_000;

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

function answers(items: FakeHubItem[], devPids: number[] = []): Record<string, unknown> {
  const now = Date.now();
  return {
    pace: [
      { provider: "claude", account: "e2e@example.com", active: true, login: "ok", used: 92, fiveHour: { used: 30, resetsAt: now + HOUR }, status: "ok" },
      { provider: "codex", account: "e2e@example.com", active: true, login: "ok", used: 28, fiveHour: null, status: "ok" },
    ],
    mac: {
      at: now, cores: 12, strained: false, swapUsedGB: 1.26, swapTotalGB: 8, swapSustained: false,
      effort: { parts: [{ key: "cpu", pct: 34 }, { key: "mem", pct: 60 }] },
      mem: { totalGB: 32, usedGB: 26.8 },
      hogs: [{ pid: 2001, cpu: 0.18 }, { pid: 2101, cpu: 0.04 }],
      trees: [{ pid: 2301, cpu: 0.06 }, { pid: 4242, cpu: 0.09 }],
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
      classes: { interattivo: { go: true, reason: "12% used" }, batch: { go: false, reason: "quota finished until Monday" } },
      brakes: { muse: { go: true }, codex: { go: true } },
      providers: {},
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
    profiles: { profiles: [{ name: "prof-a", label: "lavoro" }, { name: "prof-b", label: "riserva" }, { name: "prof-c", label: "codex riserva" }] },
  };
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

function machineList(): unknown[] {
  return [
    { id: "local", name: "Mac", local: true, state: "pressione normale", level: 0, caption: "12 core · ultime 24 h",
      metrics: [{ key: "cpu", name: "CPU", pct: 31 }, { key: "mem", name: "Memoria", pct: 62 }, { key: "swap", name: "Swap", pct: 15 }, { key: "gpu", name: "GPU", pct: 38 }, { key: "disk", name: "Disco", pct: 70 }] },
    { id: "pc", name: "PC", local: false, state: "lavora", level: 0, caption: "dorme dopo 20 min senza lavoro",
      lines: ["Collegato dal Mac", "Suite e2e di acme-web, mandata dal Mac carico"],
      metrics: [{ key: "cpu", name: "CPU", pct: 25, note: "adesso" }, { key: "mem", name: "Memoria", pct: 67, note: "adesso" }, { key: "gpu", name: "GPU", pct: 4, note: "adesso" }, { key: "disk", name: "Disco", pct: 92, note: "78,0 GB liberi" }],
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
  const hub: FakeHub = { items, posts: [], devPids: [], streams: { opened: 0, closed: 0 }, close: async () => {} };
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
      req.resume();
      return send(200, { ok: true });
    }
    const all = opts.quiet ? quietAnswers() : answers(hub.items, hub.devPids);
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
