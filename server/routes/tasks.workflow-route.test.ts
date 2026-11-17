/**
 * `/api/boards/:id/workflow` after the preset went away: the columns are the
 * same for every board, only the rules (CI phase, paths for a person) are
 * written, and a caller that still sends `preset` is not broken by it.
 *
 * @covers KANBAN-102
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { freshDb, PID } from "../services/tasks-test-db";

let db: Database;
let router: ReturnType<typeof createTasksRouter>;

beforeEach(() => {
  db = freshDb();
  db.run("CREATE TABLE IF NOT EXISTS board_workflow_rules (scope TEXT PRIMARY KEY, ci_phase INTEGER, person_paths TEXT, updated_at TEXT NOT NULL)");
  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute: (pathname: string, pattern: string) => {
      const pp = pattern.split("/"), xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = decodeURIComponent(xp[i]!);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
  } as unknown as AppContext;
  router = createTasksRouter(ctx, undefined, {});
});

async function call(method: string, body?: unknown) {
  const req = new Request(`http://x/api/boards/${PID}/workflow`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const res = (await router(req, new URL(req.url), new URL(req.url).pathname, method)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const COLUMNS = ["backlog", "todo", "in_progress", "review", "ci", "done"];

test("GET gives the columns and the rules, with no preset in it", async () => {
  const r = await call("GET");
  expect(r.status).toBe(200);
  expect(r.body.columns.map((c: { id: string }) => c.id)).toEqual(COLUMNS);
  expect(r.body.rules).toMatchObject({ personPaths: [] });
  for (const gone of ["preset", "source", "own"]) expect(gone in r.body).toBe(false);
});

test("an old caller sending only `preset` (a name, `null`, or the removed one) is answered and nothing is written", async () => {
  for (const preset of ["default", null, "armonia"]) {
    const r = await call("PUT", { preset });
    expect(r.status).toBe(200);
    expect(r.body.columns.map((c: { id: string }) => c.id)).toEqual(COLUMNS);
  }
  expect(db.query("SELECT COUNT(*) AS n FROM board_workflow_rules").get()).toEqual({ n: 0 });
});

test("`preset` next to a rule is ignored and the rule is written", async () => {
  const r = await call("PUT", { preset: "default", personPaths: [{ pattern: "server/**", why: "the server" }] });
  expect(r.status).toBe(200);
  expect(r.body.rules.personPaths).toEqual([{ pattern: "server/**", why: "the server" }]);
});

test("a body with nothing to write is still refused", async () => {
  expect((await call("PUT", {})).status).toBe(400);
});

test("a row the preset left in board_workflows is not read: the board keeps the same columns", async () => {
  db.run("CREATE TABLE board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.run("INSERT INTO board_workflows (scope, preset, updated_at) VALUES ('*', 'armonia', '2026-11-01T00:00:00.000Z')");
  const r = await call("GET");
  expect(r.body.columns.map((c: { id: string }) => c.id)).toEqual(COLUMNS);
});
