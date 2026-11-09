/**
 * Who opened a card, from where, and the agent-card contract (card a7ba2d05):
 * every door lets an incomplete agent card be born, flagged; the chat it came
 * from is display only and grants nothing.
 * @covers KANBAN-05
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../services/tasks";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx, rawCall } from "./tasks-test-support";
import { withOwnSessionToken } from "./session-caller";

const GLOBAL_TOPIC_ID = "global-orchestrator-topic";
const GLOBAL_KEY = "topic:global-orchestrator";
const LONG = "A description with enough context to finish the card on its own.";

function topic(db: Database, id: string, name: string, key = `sk-${id}`): void {
  db.run("INSERT INTO topics (id, name, session_key, provider) VALUES (?, ?, ?, 'codex')", [id, name, key]);
}

describe("card origin and agent-card contract", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;
  beforeEach(() => {
    db = freshDb();
    topic(db, "top-s1", "Riunione clienti");
    topic(db, "victim", "Victim chat");
    topic(db, GLOBAL_TOPIC_ID, "Coordinator", GLOBAL_KEY);
    db.run(
      "INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at) VALUES ('global', ?, 'x', 'x')",
      [GLOBAL_TOPIC_ID],
    );
    router = createTasksRouter(makeCtx(db, [], {
      sv: { projectPath: "/proj/one", name: "sv", topicId: "victim" },
      [GLOBAL_KEY]: { projectPath: "/proj/one", name: "coordinator", topicId: GLOBAL_TOPIC_ID },
    }), undefined, { listProjectDirs: () => ["/proj/one", "/proj/two"] });
  });

  // A session door is called by that session's own bridge, so it carries the
  // session token (`lib/session-token.ts`); board doors are left as given.
  const post = async (path: string, body: unknown, headers?: HeadersInit) => {
    const res = (await rawCall(router, "POST", path, body, withOwnSessionToken(path, headers)))!;
    return { status: res.status, body: await res.json() };
  };

  test("raw POSTs the automations send are accepted (no 400): only text, source, parentTaskId, _auto", async () => {
    const bare = await post("/api/boards/pX/tasks", { text: "board-card style" });
    expect(bare.status).toBe(201);
    expect(bare.body.createdBy).toBe("agent:api");
    expect(bare.body.createdMissing).toEqual(["context", "bar", "source"]);

    const described = await post("/api/boards/pX/tasks", { text: "sync style", description: LONG, source: "task-sync", createdBy: "agent:sync" });
    expect(described.status).toBe(201);
    expect(described.body.createdSource).toBe("task-sync");
    expect(described.body.createdMissing).toEqual(["bar"]);

    const step = await post("/api/boards/pX/tasks", { text: "a step", parentTaskId: bare.body.id });
    expect(step.status).toBe(201);
    expect(step.body.createdMissing).toContain("context");

    const auto = await post("/api/boards/_auto/tasks", { text: "no project at all" });
    expect(auto.status).toBe(201);
    expect(auto.body.createdMissing).toContain("directory");
  });

  test("an incomplete agent card carries a system comment saying what is missing", async () => {
    const t = await post("/api/boards/pX/tasks", { text: "bare" });
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.body.id}`))!.json();
    const note = got.comments.find((c: any) => c.author === "system");
    expect(note.content).toContain("Incomplete card");
    expect(note.content).toContain("acceptance bar");
  });

  test("a complete agent card is not flagged, and a human card never is", async () => {
    const ok = await post("/api/boards/pX/tasks", { text: "full", description: LONG, bar: "bun test x", source: "chat:abc" });
    expect(ok.body.createdMissing).toBeUndefined();
    expect(ok.body.bar).toBe("bun test x");
    const mine = await post("/api/boards/pX/tasks", { text: "mine" }, { "X-Topics-Action-Origin": "interface" });
    expect(mine.body.createdBy).toBe("human");
    expect(mine.body.createdMissing).toBeUndefined();
  });

  test("the flag shrinks as the card is completed, and survives a comment", async () => {
    const t = await post("/api/boards/pX/tasks", { text: "bare" });
    await call(router, "POST", `/api/boards/pX/tasks/${t.body.id}/comments`, { content: "just a note" });
    let got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.body.id}`))!.json();
    expect(got.task.createdMissing).toEqual(["context", "bar", "source"]);
    await call(router, "PATCH", `/api/boards/pX/tasks/${t.body.id}`, { description: LONG, bar: "bun test" });
    got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.body.id}`))!.json();
    expect(got.task.createdMissing).toEqual(["source"]);
  });

  // Measured 08/11: 15 grouping parents born in backlog to hold 52 cards, each
  // with "Incomplete card" in its thread. A container has nothing to finish.
  describe("a never-worked backlog parent with children is a container, not a work card", () => {
    const groupingParent = async () => (await post("/api/boards/pX/tasks", { text: "madre", description: LONG, status: "backlog" })).body;
    const thread = async (id: string) => (await (await call(router, "GET", `/api/boards/pX/tasks/${id}`))!.json());
    const notices = (got: any) => got.comments.filter((c: any) => c.author === "system" && c.content.startsWith("Incomplete card"));

    test("a child born under it drops the flag and the notice; the child keeps its own", async () => {
      const m = await groupingParent();
      expect(notices(await thread(m.id))).toHaveLength(1);
      const child = await post("/api/boards/pX/tasks", { text: "figlia", parentTaskId: m.id });
      const got = await thread(m.id);
      expect(got.task.createdMissing).toBeUndefined();
      expect(notices(got)).toEqual([]);
      expect(child.body.createdMissing).toContain("bar");
    });

    test("an existing card hung under it does the same", async () => {
      const m = await groupingParent();
      const card = await post("/api/boards/pX/tasks", { text: "card", status: "backlog" });
      await call(router, "PATCH", `/api/boards/pX/tasks/${card.body.id}`, { parentTaskId: m.id });
      const got = await thread(m.id);
      expect(got.task.createdMissing).toBeUndefined();
      expect(notices(got)).toEqual([]);
      expect(notices(await thread(card.body.id))).toHaveLength(1);
    });

    test("a parent a turn already touched, or one waiting in todo, keeps both", async () => {
      const worked = await groupingParent();
      db.run("UPDATE tasks SET dispatch_attempts = 1 WHERE id = ?", [worked.id]);
      await post("/api/boards/pX/tasks", { text: "figlia", parentTaskId: worked.id });
      const a = await thread(worked.id);
      expect(a.task.createdMissing).toEqual(["bar", "source"]);
      expect(notices(a)).toHaveLength(1);

      const queued = (await post("/api/boards/pX/tasks", { text: "in coda", description: LONG, status: "todo" })).body;
      await post("/api/boards/pX/tasks", { text: "figlia", parentTaskId: queued.id });
      const b = await thread(queued.id);
      expect(b.task.createdMissing).toEqual(["bar", "source"]);
      expect(notices(b)).toHaveLength(1);
    });
  });

  test("a legacy card (no created_missing) is never flagged", async () => {
    const t = await post("/api/boards/pX/tasks", { text: "old" });
    db.run("UPDATE tasks SET created_missing = NULL, created_by = NULL WHERE id = ?", [t.body.id]);
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.body.id}`))!.json();
    expect(got.task.createdMissing).toBeUndefined();
    expect(got.task.createdBy).toBeNull();
  });

  test("the agent header names the agent: X-Topics-Agent gives a readable createdBy", async () => {
    const t = await post("/api/boards/pX/tasks", { text: "named" }, { "X-Topics-Agent": "jarvis" });
    expect(t.body.createdBy).toBe("agent:jarvis");
  });

  test("session door: source and chat are set by the server, with the chat name", async () => {
    const t = await post("/api/sessions/s1/tasks", { text: "from a chat", description: LONG, bar: "bun test" });
    expect(t.status).toBe(201);
    expect(t.body.createdSource).toBe("session:s1");
    expect(t.body.openerTopicId).toBe("top-s1");
    expect(t.body.openerName).toBe("Riunione clienti");
    expect(t.body.createdMissing).toBeUndefined();
    const list = await (await call(router, "GET", "/api/boards/" + t.body.projectId + "/tasks"))!.json();
    expect(list.tasks[0].openerName).toBe("Riunione clienti");
  });

  test("coordinator door: source, origin and createdBy fields never 400, and the card is flagged", async () => {
    const board = projectIdForPath("/proj/two");
    const res = await post(`/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_KEY)}/tasks`, {
      board_id: board, text: "from the coordinator", source: "x", origin_topic_id: "nope",
      createdBy: "human", created_by: "human", createdSource: "y", bar: "bun test",
    });
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe("agent:coordinator");
    expect(res.body.createdMissing).toEqual(["context"]);
    expect(res.body.openerName).toBe("Coordinator");
  });

  test("a deleted origin chat is not offered as a link", async () => {
    const t = await post("/api/sessions/s1/tasks", { text: "orphan" });
    db.run("DELETE FROM topics WHERE id = 'top-s1'");
    const got = await (await call(router, "GET", `/api/sessions/s1/tasks/${t.body.id}`))!.json();
    expect(got.task.openerTopicId).toBeUndefined();
  });

  test("originTopicId in the body is display only: it grants no closing power and is not a source", async () => {
    const t = await post(`/api/boards/${projectIdForPath("/proj/one")}/tasks`, { text: "forged", originTopicId: "victim" });
    expect(t.body.openerTopicId).toBe("victim");
    expect(t.body.createdMissing).toContain("source");
    const row = db.query("SELECT created_by_topic_id, origin_topic_id FROM tasks WHERE id = ?").get(t.body.id) as any;
    expect(row.created_by_topic_id).toBeNull();
    expect(row.origin_topic_id).toBe("victim");
    db.run("UPDATE tasks SET status = 'review' WHERE id = ?", [t.body.id]);
    const done = (await call(router, "PATCH", `/api/sessions/sv/tasks/${t.body.id}`, { status: "done" }))!;
    expect(done.status).toBe(409);
    expect((await done.json()).code).toBe("agent_cannot_complete");
  });

  test("an unknown originTopicId is dropped", async () => {
    const t = await post("/api/boards/pX/tasks", { text: "ghost", originTopicId: "no-such-chat" });
    expect(t.body.openerTopicId).toBeUndefined();
    const row = db.query("SELECT origin_topic_id FROM tasks WHERE id = ?").get(t.body.id) as any;
    expect(row.origin_topic_id).toBeNull();
  });

  test("a forged originTopicId on a STEP with a parent gives no right to close it either", async () => {
    const pid = projectIdForPath("/proj/one");
    const parent = await post(`/api/boards/${pid}/tasks`, { text: "parent" });
    const step = await post(`/api/boards/${pid}/tasks`, { text: "step", parentTaskId: parent.body.id, originTopicId: "victim" });
    expect(step.status).toBe(201);
    const row = db.query("SELECT created_by_topic_id, parent_task_id FROM tasks WHERE id = ?").get(step.body.id) as any;
    expect(row.parent_task_id).toBe(parent.body.id);
    expect(row.created_by_topic_id).toBeNull();
    db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [step.body.id]);
    const done = (await call(router, "PATCH", `/api/sessions/sv/tasks/${step.body.id}`, { status: "done" }))!;
    expect(done.status).toBeGreaterThanOrEqual(400);
    expect(db.query("SELECT status FROM tasks WHERE id = ?").get(step.body.id)).toEqual({ status: "in_progress" });
  });

  test("source can be added after birth (PATCH) and clears the incomplete flag", async () => {
    const t = await post(`/api/boards/${projectIdForPath("/proj/one")}/tasks`, { text: "late", description: LONG, bar: "bun test" });
    expect(t.body.createdMissing).toEqual(["source"]);
    for (const field of ["source", "createdSource", "created_source"]) {
      const res = (await call(router, "PATCH", `/api/sessions/sv/tasks/${t.body.id}`, { [field]: `session:${field}` }))!;
      expect(res.status).toBe(200);
    }
    const got = await (await call(router, "GET", `/api/sessions/sv/tasks/${t.body.id}`))!.json();
    expect(got.task.createdSource).toBe("session:created_source");
    expect(got.task.createdMissing).toBeUndefined();
  });

  test("the coordinator can complete an incomplete card: PATCH bar through the global door", async () => {
    const board = projectIdForPath("/proj/two");
    const base = `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_KEY)}/tasks`;
    const t = await post(base, { board_id: board, text: "needs a bar", description: LONG, source: "session:s1" });
    expect(t.body.createdMissing).toEqual(["bar"]);
    const res = (await call(router, "PATCH", `${base}/${t.body.id}`, { bar: "bun test" }))!;
    expect(res.status).toBe(200);
    const got = await (await call(router, "GET", `${base}/${t.body.id}`))!.json();
    expect(got.task.createdMissing).toBeUndefined();
  });

  test("listing thousands of cards stays fast: the opener lookup is one prepared statement", async () => {
    const board = projectIdForPath("/proj/one");
    const run = db.transaction(() => {
      for (let n = 0; n < 3000; n++) {
        db.run(
          "INSERT INTO tasks (id, project_id, text, status, priority, created_by, origin_topic_id, created_at, updated_at) VALUES (?, ?, ?, 'backlog', 2, 'agent:session', 'top-s1', 'x', 'x')",
          [`bulk-${n}`, board, `card ${n}`],
        );
      }
    });
    run();
    // Count the statements, not the milliseconds: a cold first GET on a loaded
    // machine overshoots any fixed time budget even without the opener lookup.
    const prepare = db.prepare.bind(db);
    let openerPrepares = 0;
    db.prepare = ((sql: string) => {
      if (sql.includes("FROM topics WHERE id = ?")) openerPrepares++;
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      const res = (await call(router, "GET", `/api/boards/${board}/tasks`))!;
      const body = await res.json();
      expect(body.tasks.filter((t: { openerName?: string }) => t.openerName === "Riunione clienti").length).toBe(3000);
    } finally {
      db.prepare = prepare;
    }
    expect(openerPrepares).toBeLessThanOrEqual(1);
  });
});
