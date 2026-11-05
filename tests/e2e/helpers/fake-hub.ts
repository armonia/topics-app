/**
 * A fake usage hub for the hub specs, on the port the test server is
 * told to look at (`hubPortFor`, `TOPICS_HUB_URL` in `testServerEnv`). It
 * answers the paths the live reader asks (server/lib/hub-live.ts) with trimmed
 * copies of the real hub's shapes, and closes a "waiting for you" item on
 * the close request the way the real hub does (same path and body as
 * `closeWaitingBody` in client/src/lib/hubSystem.ts). It also stands in for
 * the Claude proxy's account log (`activity`, `profiles`: the test server
 * points `TOPICS_SWITCHBOARD_URL` here) and takes «Fix it» (`fix`). Nothing
 * here ever reaches :3360 or :3335.
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

function answers(items: FakeHubItem[]): Record<string, unknown> {
  const now = Date.now();
  return {
    pace: [
      { provider: "claude", account: "e2e@example.com", active: true, login: "ok", used: 92, fiveHour: { used: 30, resetsAt: now + HOUR }, status: "ok" },
      { provider: "codex", account: "e2e@example.com", active: true, login: "ok", used: 28, fiveHour: null, status: "ok" },
    ],
    mac: { at: now, cores: 12, strained: false, swapUsedGB: 1.26, swapSustained: false, effort: { parts: [{ key: "cpu", pct: 34 }, { key: "mem", pct: 60 }] } },
    services: { at: now, services: [
      { id: "usage-hub", name: "Hub dei consumi", state: "vivo", problem: null },
      { id: "docs-index", name: "Indice dei documenti", state: "vivo", problem: "non ascolta su :3342" },
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

export async function startFakeHub(items: FakeHubItem[] = defaultFakeHubItems()): Promise<FakeHub> {
  const hub: FakeHub = { items, posts: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!.replace(/^\/api\//, "");
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
    if (req.method === "POST" && path === "fix") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        hub.posts.push({ path, ...body });
        send(200, { ok: true, item: { id: "e2e-fix", status: "queued" } });
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
    const all = answers(hub.items);
    if (req.method === "GET" && path in all) return send(200, all[path]);
    send(404, { error: "not in the fake hub" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(hubPortFor(), "127.0.0.1", () => resolve());
  });
  hub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return hub;
}
