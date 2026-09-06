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
import { closeGoal, getActiveGoal, getGoal, setGoal } from "../services/goals";

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
  db.run(`CREATE TABLE global_orchestrator_sessions (
    scope TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(readFileSync(join(import.meta.dir, "..", "db", "migrations", "064-topic-goals.sql"), "utf-8"));
  db.run("INSERT INTO topics (id, session_key) VALUES ('t1', 'topic:aaaaaaaa'), ('t2', 'topic:bbbbbbbb'), ('global', 'topic:global')");
  db.run(`INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
    VALUES ('global', 'global', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')`);
  broadcasts = [];
  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute,
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    broadcast: (msg: Record<string, unknown>) => { broadcasts.push(msg); },
    getTopicById: (id: string) => {
      const row = db.query("SELECT id, session_key FROM topics WHERE id = ?").get(id) as { id: string; session_key: string } | null;
      return row ? { id: row.id, sessionKey: row.session_key } : null;
    },
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

/**
 * The agent writes its own objective (card d2a4a907). Until now the goal came
 * only from `/goal` and the steps only from an ACP `plan`, so with the native
 * runtime a twenty-step job ran with an empty bar.
 *
 * The one rule worth a test of its own: an objective the PERSON declared is
 * never overwritten. Everything else here is the plumbing that makes the bar
 * fill up.
 * @covers CTX-GOAL-03
 */
describe("PUT /api/sessions/:sessionKey/goal", () => {
  test("declares the goal as the agent's, and announces it", async () => {
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "Portare a verde la suite" });
    expect(r.status).toBe(201);
    expect(r.body.goal.content).toBe("Portare a verde la suite");
    expect(r.body.goal.createdBy).toBe("agent");
    expect(getActiveGoal(db, "t1")?.createdBy).toBe("agent");
    expect(broadcasts.some((b) => b.type === "goal:updated" && b.topicId === "t1")).toBe(true);
  });

  test("REFUSES to replace a goal the person declared, and says what to do instead", async () => {
    setGoal(db, { topicId: "t1", content: "Sistemare il login", createdBy: "human" });
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "Rifare il layout" });
    expect(r.status).toBe(409);
    // The message must NAME the goal in force and the way out, otherwise the
    // model retries the same call.
    expect(r.body.error).toContain("Sistemare il login");
    expect(r.body.error).toContain("update_goal_steps");
    // And nothing moved.
    expect(getActiveGoal(db, "t1")?.content).toBe("Sistemare il login");
    expect(broadcasts.length).toBe(0);
  });

  test("replaces a goal the AGENT itself had declared", async () => {
    setGoal(db, { topicId: "t1", content: "Prima idea", createdBy: "agent" });
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "Idea giusta" });
    expect(r.status).toBe(201);
    expect(getActiveGoal(db, "t1")?.content).toBe("Idea giusta");
  });

  test("re-declaring the SAME objective keeps the row, and its steps", async () => {
    // After a compaction the model calls set_goal again with the same sentence:
    // a fresh row would drop the plan it had already reported.
    const first = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "Stessa cosa" });
    await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", { steps: [{ content: "p1", status: "completed" }] });
    const again = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "Stessa cosa" });
    expect(again.body.goal.id).toBe(first.body.goal.id);
    expect(getActiveGoal(db, "t1")?.steps.length).toBe(1);
  });

  test("empty content is 400, and no topic is 404", async () => {
    expect((await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "  " })).status).toBe(400);
    expect((await call("PUT", "/api/sessions/topic%3Anobody/goal", { content: "x" })).status).toBe(404);
  });
});

describe("PUT /api/sessions/:sessionKey/goal/steps", () => {
  test("replaces the whole plan of the active goal and announces it", async () => {
    setGoal(db, { topicId: "t1", content: "Rilasciare", createdBy: "agent" });
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", {
      steps: [
        { content: "Leggere il router", status: "completed" },
        { content: "Scrivere il test", status: "in_progress" },
        { content: "Passare i cancelli" },
      ],
    });
    expect(r.status).toBe(200);
    const steps = getActiveGoal(db, "t1")!.steps;
    expect(steps.map((s) => s.content)).toEqual(["Leggere il router", "Scrivere il test", "Passare i cancelli"]);
    expect(steps.map((s) => s.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(broadcasts.some((b) => b.type === "goal:updated")).toBe(true);
  });

  test("planning INSIDE the person's goal is allowed: writing the plan is doing the job", async () => {
    setGoal(db, { topicId: "t1", content: "Sistemare il login", createdBy: "human" });
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", { steps: [{ content: "p1" }] });
    expect(r.status).toBe(200);
    expect(getActiveGoal(db, "t1")?.createdBy).toBe("human");
  });

  test("no active goal: 404, and no goal is invented", async () => {
    const r = await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", { steps: [{ content: "p1" }] });
    expect(r.status).toBe(404);
    expect(getActiveGoal(db, "t1")).toBeNull();
  });

  test("steps that is not an array is 400", async () => {
    setGoal(db, { topicId: "t1", content: "A", createdBy: "agent" });
    expect((await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", { steps: "p1" })).status).toBe(400);
  });
});

describe("POST /api/goals/:id/promote", () => {
  test("the person adopts the proposal: same row, same steps, now theirs", async () => {
    const g = setGoal(db, { topicId: "t1", content: "Proposta", createdBy: "agent" });
    await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal/steps", { steps: [{ content: "p1", status: "completed" }] });
    const r = await call("POST", `/api/goals/${g.id}/promote`);
    expect(r.status).toBe(200);
    expect(r.body.goal.id).toBe(g.id);
    expect(r.body.goal.createdBy).toBe("human");
    expect(r.body.goal.steps.length).toBe(1);
    // And now the agent cannot replace it any more: that is the point.
    expect((await call("PUT", "/api/sessions/topic%3Aaaaaaaaa/goal", { content: "altro" })).status).toBe(409);
  });

  test("an unknown goal is 404", async () => {
    expect((await call("POST", "/api/goals/nope/promote")).status).toBe(404);
  });
});

describe("global coordinator goal isolation", () => {
  test("raw registry role cannot read, create, or close generic topic goals by topic or self session", async () => {
    const goal = setGoal(db, { topicId: "global", content: "Must remain inaccessible" });

    const byTopicGet = await call("GET", "/api/topics/global/goal");
    const byTopicPut = await call("PUT", "/api/topics/global/goal", { content: "Create an escape" });
    const byTopicDelete = await call("DELETE", "/api/topics/global/goal", { status: "achieved" });
    const bySessionGet = await call("GET", "/api/sessions/topic%3Aglobal/goal");
    const bySessionDelete = await call("DELETE", "/api/sessions/topic%3Aglobal/goal", { status: "achieved" });

    for (const response of [byTopicGet, byTopicPut, byTopicDelete, bySessionGet, bySessionDelete]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
    expect(getActiveGoal(db, "global")?.id).toBe(goal.id);
    expect(broadcasts).toEqual([]);
  });

  test("raw registry role cannot reopen a coordinator goal or replace its steps by goal id", async () => {
    const goal = setGoal(db, { topicId: "global", content: "Do not mutate this goal" });
    closeGoal(db, goal.id, "achieved");

    const reopen = await call("POST", `/api/goals/${goal.id}/reopen`);
    const steps = await call("PUT", `/api/goals/${goal.id}/steps`, {
      steps: [{ content: "Mutate through the id route", status: "completed" }],
    });

    for (const response of [reopen, steps]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
    expect(getGoal(db, goal.id)).toMatchObject({ status: "achieved", steps: [] });
    expect(broadcasts).toEqual([]);
  });

  test("ordinary Topics retain their direct goal API", async () => {
    const created = await call("PUT", "/api/topics/t1/goal", { content: "Ship the normal Topic" });
    const read = await call("GET", "/api/topics/t1/goal");

    expect(created.status).toBe(201);
    expect(read.status).toBe(200);
    expect(read.body.goal.content).toBe("Ship the normal Topic");
  });

  test("the coordinator is refused on the loop, the session steps and promote routes too", async () => {
    // Goals live on the coordinator row only when planted directly in SQL:
    // every HTTP door, including the three added on main after the feature
    // branched, must stay shut.
    const goal = setGoal(db, { topicId: "global", content: "Planted directly", createdBy: "agent" });

    const loop = await call("POST", "/api/topics/global/goal/loop", { state: "stopped" });
    const sessionPut = await call("PUT", "/api/sessions/topic%3Aglobal/goal", { content: "Escape by session" });
    const sessionSteps = await call("PUT", "/api/sessions/topic%3Aglobal/goal/steps", { steps: [{ content: "p1" }] });
    const promote = await call("POST", `/api/goals/${goal.id}/promote`);

    for (const response of [loop, sessionPut, sessionSteps, promote]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
    expect(getGoal(db, goal.id)).toMatchObject({ createdBy: "agent", status: "active", steps: [] });
    expect(broadcasts).toEqual([]);
  });
});
