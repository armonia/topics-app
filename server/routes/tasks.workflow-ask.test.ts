/**
 * The reviewer's repro of 31/10 on the real agent routes: an agent asks the
 * person with `add_comment(options)` and then delivers without `human_ask`.
 * The question is a question however it is asked: the card carries it as its
 * `human_ask` and rings (`task:review-ready`). There is no AI review column
 * any more: every delivery waits on a person.
 *
 * @covers KANBAN-102
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";

const TOPIC = "topic-worker";
const SK = "sk-worker";

let db: Database;
let broadcasts: Array<{ type: string; taskId?: string }>;
let router: ReturnType<typeof createTasksRouter>;

beforeEach(() => {
  db = freshDb();
  db.run("INSERT INTO topics (id) VALUES (?)", [TOPIC]);
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

test("a question in the thread, then a delivery without human_ask: the question is the human_ask, and it rings", async () => {
  const id = apiCard();
  expect((await ask(id)).status).toBe(201);
  const d = await deliver(id);
  expect(d.status).toBe(200);
  expect(d.body).toMatchObject({ status: "review", humanAsk: "Which layout do you prefer?" });
  expect(d.body.stage).toBeUndefined();
  expect(rang(id)).toBe(1);
});

test("a delivery with no question rings too: it waits on a person all the same", async () => {
  const id = apiCard();
  const d = await deliver(id);
  expect(d.body).toMatchObject({ status: "review" });
  expect(d.body.stage).toBeUndefined();
  expect(rang(id)).toBe(1);
});

const born = (body: Record<string, unknown>) =>
  call("POST", `/api/boards/${PID}/tasks`, { text: "born in review", status: "review", createdBy: "agent:api", ...body });

test("a machine card born in review has no column to name but the plain one: human_review is refused", async () => {
  const refused = await born({ stage: "human_review" });
  expect(refused.status).toBe(400);
  const plain = await born({});
  expect(plain.status).toBe(201);
  expect(plain.body).toMatchObject({ status: "review" });
  expect(plain.body.stage).toBeUndefined();
  const asked = await born({ human_ask: "Which layout?" });
  expect(asked.status).toBe(201);
  expect(asked.body).toMatchObject({ humanAsk: "Which layout?" });
});
