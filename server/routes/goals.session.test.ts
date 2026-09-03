/**
 * The goal, addressed by SESSION KEY: the way an agent knows itself.
 *
 * `/api/topics/:id/goal` existed for the UI, which has the topic id in hand.
 * A tool running inside a session has `topic:xxxxxxxx` and nothing else, and
 * until 2026-09-03 no way to read or close the goal it had been given. These
 * two routes resolve the topic and delegate to the same service, so closing
 * from the chat and closing from the panel are the same operation.
 * @covers CTX-GOAL-02
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { createGoalsRouter } from "./goals";
import { getActiveGoal, setGoal } from "../services/goals";

let db: Database;
let broadcasts: Array<Record<string, unknown>>;
let router: ReturnType<typeof createGoalsRouter>;

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"); const xs = pathname.split("/");
  if (pp.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = xs[i]!;
    else if (pp[i] !== xs[i]) return null;
  }
  return params;
}

async function call(method: string, path: string, body?: unknown) {
  const req = new Request(`http://x${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const res = await router(req, new URL(req.url), path, method);
  return { status: res?.status ?? 0, body: res ? await res.json() : null };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT)");
  db.run(readFileSync(join(import.meta.dir, "..", "db", "migrations", "064-topic-goals.sql"), "utf-8"));
  db.run("INSERT INTO topics (id, session_key) VALUES ('t1', 'topic:aaaaaaaa'), ('t2', 'topic:bbbbbbbb')");
  broadcasts = [];
  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute,
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    broadcast: (msg: Record<string, unknown>) => { broadcasts.push(msg); },
    getTopicBySessionKey: (key: string) => {
      const row = db.query("SELECT id FROM topics WHERE session_key = ?").get(key) as { id: string } | null;
      return row ? { id: row.id, sessionKey: key } : null;
    },
  };
  router = createGoalsRouter(ctx as never);
});

describe("GET /api/sessions/:sessionKey/goal", () => {
  test("returns the active goal of the session's topic and its history", async () => {
    setGoal(db, { topicId: "t1", content: "Ship the retry" });
    const r = await call("GET", "/api/sessions/topic%3Aaaaaaaaa/goal");
    expect(r.status).toBe(200);
    expect(r.body.goal.content).toBe("Ship the retry");
    expect(r.body.history.length).toBe(1);
  });

  test("a session with no topic: 404, not an empty goal", async () => {
    const r = await call("GET", "/api/sessions/topic%3Anobody/goal");
    expect(r.status).toBe(404);
  });

  test("the other topic's goal never leaks through", async () => {
    setGoal(db, { topicId: "t2", content: "Something else" });
    const r = await call("GET", "/api/sessions/topic%3Aaaaaaaaa/goal");
    expect(r.body.goal).toBeNull();
  });
});

describe("DELETE /api/sessions/:sessionKey/goal", () => {
  test("closes as achieved when asked, and announces it", async () => {
    setGoal(db, { topicId: "t1", content: "Ship the retry" });
    const r = await call("DELETE", "/api/sessions/topic%3Aaaaaaaaa/goal", { status: "achieved" });
    expect(r.status).toBe(200);
    expect(r.body.goal.status).toBe("achieved");
    expect(getActiveGoal(db, "t1")).toBeNull();
    expect(broadcasts.some((b) => b.type === "goal:updated" && b.topicId === "t1")).toBe(true);
  });

  test("a close with no status is an abandonment, the same default as the topic route", async () => {
    setGoal(db, { topicId: "t1", content: "Ship the retry" });
    const r = await call("DELETE", "/api/sessions/topic%3Aaaaaaaaa/goal");
    expect(r.body.goal.status).toBe("abandoned");
  });

  test("no active goal: 404", async () => {
    const r = await call("DELETE", "/api/sessions/topic%3Aaaaaaaaa/goal", { status: "achieved" });
    expect(r.status).toBe(404);
  });
});
