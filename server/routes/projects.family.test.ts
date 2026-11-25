/**
 * `PATCH /api/projects/:id` with `parentId` and `mergeMode`: accorpa / separa.
 * @covers WORKTREE-STD-06
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";
import { createProjectStore } from "../services/project-store";

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
let broadcasts: Array<{ type: string; project: { id: string; parentId?: string | null; mergeMode?: string } }>;
let ids: { parent: string; child: string; other: string };

function patch(id: string, body: unknown) {
  const url = new URL(`http://x/api/projects/${id}`);
  return router(new Request(url, { method: "PATCH", body: JSON.stringify(body) }), url, `/api/projects/${id}`, "PATCH");
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    color TEXT, icon TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    org_id TEXT, owner_person_id TEXT, incognito INTEGER NOT NULL DEFAULT 0
  )`);
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261124110000-projects-parent-merge.sql"), "utf8"));
  const projectStore = createProjectStore(db);
  const mk = (slug: string) => projectStore.create({ name: slug, slug, path: `/w/${slug}` }).id;
  ids = { parent: mk("shopcms"), child: mk("shopcms-moduli"), other: mk("acme-site") };
  broadcasts = [];
  const ctx = {
    db,
    projectStore,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json().catch(() => null),
    matchRoute,
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
    broadcastProject: (type: string, project: (typeof broadcasts)[number]["project"]) => { broadcasts.push({ type, project }); },
    broadcastToProjectViewers: () => {},
  } as unknown as AppContext;
  router = createProjectsRouter(ctx) as typeof router;
});

afterEach(() => { db.close(); });

describe("PATCH /api/projects/:id family", () => {
  test("puts a project under a parent, merged by default, and broadcasts the row", async () => {
    const res = await patch(ids.child, { parentId: ids.parent });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ parentId: ids.parent, mergeMode: "accorpa" });
    expect(broadcasts.at(-1)).toMatchObject({ type: "project:updated", project: { id: ids.child, parentId: ids.parent } });
  });

  test("separa and accorpa flip the mode without touching the parent", async () => {
    await patch(ids.child, { parentId: ids.parent });
    expect(await (await patch(ids.child, { mergeMode: "separa" }))!.json()).toMatchObject({ parentId: ids.parent, mergeMode: "separa" });
    expect(await (await patch(ids.child, { mergeMode: "accorpa" }))!.json()).toMatchObject({ parentId: ids.parent, mergeMode: "accorpa" });
  });

  test("parentId null detaches", async () => {
    await patch(ids.child, { parentId: ids.parent });
    expect(await (await patch(ids.child, { parentId: null }))!.json()).toMatchObject({ parentId: null });
  });

  test("a second level, a self parent, an unknown parent and a bad mode are refused", async () => {
    await patch(ids.child, { parentId: ids.parent });
    expect((await patch(ids.other, { parentId: ids.child }))!.status).toBe(409);
    expect((await patch(ids.parent, { parentId: ids.other }))!.status).toBe(409);
    expect((await patch(ids.other, { parentId: ids.other }))!.status).toBe(409);
    expect((await patch(ids.other, { parentId: "ghost" }))!.status).toBe(404);
    expect((await patch(ids.other, { mergeMode: "merge" }))!.status).toBe(400);
    expect((await patch(ids.other, { parentId: 7 }))!.status).toBe(400);
  });

  test("a name change keeps working next to the family fields", async () => {
    const res = await patch(ids.child, { name: "modules", parentId: ids.parent });
    expect(await res!.json()).toMatchObject({ name: "modules", parentId: ids.parent });
  });
});
