/**
 * The reviewer's repro of 31/10 on the real agent routes: on the `armonia`
 * workflow, an agent asks the person with `add_comment(options)` and then
 * delivers without `human_ask`. The question is a question however it is
 * asked: the card reaches Human review with it and rings (`task:review-ready`),
 * also when the question is written after the delivery.
 *
 * @covers KANBAN-102
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";
import { writeBoardWorkflow } from "../services/board-workflow";
import { _resetAiReviewNotices } from "../services/ai-review-notice";

const TOPIC = "topic-worker";
const SK = "sk-worker";

let db: Database;
let broadcasts: Array<{ type: string; taskId?: string }>;
let router: ReturnType<typeof createTasksRouter>;

beforeEach(() => {
  db = freshDb();
  db.run("CREATE TABLE board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.run("INSERT INTO topics (id) VALUES (?)", [TOPIC]);
  writeBoardWorkflow(db, PID, "armonia", "2026-10-31T10:00:00.000Z");
  _resetAiReviewNotices();
  broadcasts = [];
  const topic = { id: TOPIC, name: "worker", projectPath: "/Users/x/Projects/topics-app" };
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
    broadcastToAll: (m: { type: string; taskId?: string }) => { broadcasts.push(m); },
    getTopicById: (id: string) => (id === TOPIC ? topic : null),
    getTopicBySessionKey: (sk: string) => (sk === SK ? topic : null),
    worktreeStore: { get: () => null },
  } as unknown as AppContext;
  router = createTasksRouter(ctx, undefined, {});
});

/** A card the board API opened (`agent:api`), being worked by TOPIC. */
function apiCard(): string {
  const t = createTaskService(db).create({ projectId: PID, text: "card from the board API", status: "todo", createdBy: "agent:api", priority: 1, description: "bar" });
  db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?", [TOPIC, t.id]);
  return t.id;
}

async function call(method: string, path: string, body: unknown) {
  const req = new Request(`http://x${path}`, { method, body: JSON.stringify(body) });
  const res = (await router(req, new URL(req.url), new URL(req.url).pathname, method)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const ask = (id: string) => call("POST", `/api/sessions/${SK}/tasks/${id}/comments`, { content: "Which layout do you prefer?", options: ["A (recommended)", "B"] });
const deliver = (id: string) => call("PATCH", `/api/sessions/${SK}/tasks/${id}`, { status: "review", summary: "two layouts ready" });
const rang = (id: string) => broadcasts.filter((b) => b.type === "task:review-ready" && b.taskId === id).length;

test("a question in the thread, then a delivery without human_ask: Human review, and it rings", async () => {
  const id = apiCard();
  expect((await ask(id)).status).toBe(201);
  const d = await deliver(id);
  expect(d.status).toBe(200);
  expect(d.body).toMatchObject({ status: "review", stage: "human_review", humanAsk: "Which layout do you prefer?" });
  expect(rang(id)).toBe(1);
});

test("a question written after the delivery moves the card out of AI review, and it rings", async () => {
  const id = apiCard();
  const d = await deliver(id);
  expect(d.body).toMatchObject({ stage: "ai_review" });
  expect(rang(id)).toBe(0);
  expect((await ask(id)).status).toBe(201);
  const row = db.query("SELECT stage, human_ask FROM tasks WHERE id = ?").get(id);
  expect(row).toEqual({ stage: "human_review", human_ask: "Which layout do you prefer?" });
  expect(rang(id)).toBe(1);
  // A further comment on a card already in Human review does not ring again.
  await ask(id);
  expect(rang(id)).toBe(1);
});
