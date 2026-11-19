/**
 * `GET`/`POST /api/projects/quota-limit` — the project menu's "Limite nelle
 * 24 ore" (limiti-consumo-progetto, USAGE-29). allow-italian: openspec change name and UI label quoted for context
 * @covers USAGE-29
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";

const MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261119000000-project-quota.sql")).text();

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = decodeURIComponent(xp[i]!);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

let db: Database;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;

function get(path: string) {
  const url = new URL(`http://x/api/projects/quota-limit?path=${encodeURIComponent(path)}`);
  return router(new Request(url), url, "/api/projects/quota-limit", "GET");
}
function post(body: unknown) {
  const url = new URL("http://x/api/projects/quota-limit");
  return router(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, "/api/projects/quota-limit", "POST");
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)`);
  db.run(`CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, abs_path TEXT NOT NULL)`);
  db.exec(MIGRATION);
  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json().catch(() => null),
    matchRoute,
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
  } as unknown as AppContext;
  router = createProjectsRouter(ctx) as typeof router;
});

afterEach(() => { db.close(); });

describe("GET /api/projects/quota-limit", () => {
  test("a project never configured reads the default (10)", async () => {
    const res = await get("/proj/a");
    expect(await res!.json()).toEqual({ limit: 10 });
  });
});

describe("POST /api/projects/quota-limit", () => {
  test("writes the choice and reads it back", async () => {
    const res = await post({ path: "/proj/a", limit: 20 });
    expect(await res!.json()).toEqual({ limit: 20 });
    expect(await (await get("/proj/a"))!.json()).toEqual({ limit: 20 });
  });

  test("null clears the limit ('Nessuno')", async () => {
    await post({ path: "/proj/a", limit: 20 });
    const res = await post({ path: "/proj/a", limit: null });
    expect(await res!.json()).toEqual({ limit: null });
  });

  test("a value outside the offered steps is refused", async () => {
    const res = await post({ path: "/proj/a", limit: 7 });
    expect(res!.status).toBe(400);
  });

  test("a path inside a worktree resolves to the same id as the project itself", async () => {
    db.run(`INSERT INTO projects (id, path) VALUES ('p1', '/proj/a')`);
    db.run(`INSERT INTO worktrees (id, project_id, abs_path) VALUES ('w1', 'p1', '/worktrees/a-feature')`);
    await post({ path: "/proj/a", limit: 15 });
    expect(await (await get("/worktrees/a-feature"))!.json()).toEqual({ limit: 15 });
  });
});

describe("POST /api/projects/:id/quota/continue and /hold (USAGE-30)", () => {
  function postId(id: string, verb: "continue" | "hold") {
    const url = new URL(`http://x/api/projects/${encodeURIComponent(id)}/quota/${verb}`);
    return router(new Request(url, { method: "POST" }), url, url.pathname, "POST");
  }

  test("'Continua' answers paused:false and broadcasts the lifted state", async () => {
    const seen: unknown[] = [];
    router = createProjectsRouter({
      db, broadcastToAll: (m: unknown) => seen.push(m),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      readJSON: (req: Request) => req.json().catch(() => null),
      matchRoute,
      errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    } as unknown as AppContext) as typeof router;
    const res = await postId("p1", "continue");
    expect(await res!.json()).toEqual({ paused: false });
    expect(seen).toEqual([{ type: "project:quota", projectId: "p1", paused: false, reason: null, limit: 10, points24h: null }]);
  });

  test("'Pausa fino a domani' answers paused:true and holds regardless of points", async () => {
    const seen: unknown[] = [];
    router = createProjectsRouter({
      db, broadcastToAll: (m: unknown) => seen.push(m),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      readJSON: (req: Request) => req.json().catch(() => null),
      matchRoute,
      errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    } as unknown as AppContext) as typeof router;
    const res = await postId("p1", "hold");
    expect(await res!.json()).toEqual({ paused: true });
    expect((seen[0] as { paused: boolean }).paused).toBe(true);
  });
});
