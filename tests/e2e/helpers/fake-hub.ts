/**
 * A fake usage hub for the System pane specs, on the port the test server is
 * told to look at (`hubPortFor`, `TOPICS_HUB_URL` in `testServerEnv`). It
 * answers the paths the live reader asks (server/lib/hub-live.ts) with trimmed
 * copies of the real hub's shapes, and closes a "waiting for you" item on
 * `POST /api/attesa {kind:'chiudi', ref}` the way the real hub does. Nothing
 * here ever reaches :3360.
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
    { id: "e2e-decide", tipo: "decisione", title: "Ship Topics 0.48 on stable, or hold for the split fix", why: "The split-pane fix is on main since this morning.", link: "https://example.com/release", from: "guardiano", due: now + 2 * HOUR },
    { id: "e2e-look", tipo: "vista", title: "Course slides, lesson 4: phone layout next to the reference", from: "sessione corso", due: now + 20 * HOUR },
    { id: "e2e-spend", tipo: "spesa", title: "Move the Nimbus DB project to the Launch plan", why: "19 EUR a month.", from: "claude" },
  ];
}

function answers(items: FakeHubItem[]): Record<string, unknown> {
  const now = Date.now();
  return {
    pace: [
      { provider: "claude", account: "e2e@example.com", active: true, login: "ok", used: 62, fiveHour: { used: 30, resetsAt: now + HOUR }, status: "ok" },
      { provider: "codex", account: "e2e@example.com", active: true, login: "ok", used: 28, fiveHour: null, status: "ok" },
    ],
    mac: { at: now, cores: 12, strained: false, swapUsedGB: 1.26, swapSustained: false, effort: { parts: [{ key: "cpu", pct: 34 }, { key: "mem", pct: 60 }] } },
    services: { at: now, services: [
      { id: "usage-hub", name: "Hub dei consumi", state: "vivo", problem: null },
      { id: "docs-index", name: "Docs index", state: "vivo", problem: "non ascolta su :3342" },
    ] },
    attesa: { at: now, items },
    alerts: { rules: [], firing: [{ id: "muse:pace", subject: "Muse pace", message: "Muse pace: 71% used, 40% expected" }] },
    gates: {
      classes: { interattivo: { go: true, reason: "12% used" }, batch: { go: false, reason: "quota finished until Monday" } },
      brakes: { muse: { go: true }, codex: { go: true } },
      providers: {},
    },
    "automations/summary": { needsYou: 0, broken: 1, ok: 81, hidden: 0, runsToday: 412, calendar: { count: 3, next: { title: "Backup of the Mac", at: now + HOUR } } },
    automations: { broken: [{ key: "gh:docs-reindex", title: "Docs index reindex", last: { at: now - HOUR, outcome: "error" } }] },
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
