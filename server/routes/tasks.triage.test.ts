/**
 * @covers KANBAN-21
 * @covers KANBAN-08
 * THE TRIAGE OF A CARD AT BIRTH, through the router (`services/card-triage.ts`).
 *
 * Measured on 2026-11-23: since 19/11 the board API created 87 of the 121 cards and none of them went
 * through the duplicate gate the MCP tools already had; and numbered batches («Lavori programmati 3/8: ...»)
 * landed as loose siblings with no card that said what the batch was. Here: the board API gives an open twin
 * back instead of a copy, a retry of a creation gets its card and not a 409, and a series is born under its
 * milestone, on both doors that open cards for an agent.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx, rawCall } from "./tasks-test-support";

const BOARD = "/api/boards/pX/tasks";
const SESSION = "/api/sessions/s1/tasks";
const TWIN = "store: UserMemoryStore.update() + test";
const TWIN_AGAIN = "store: UserMemoryStore.update() + unit test";

describe("triage at birth", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  /** An automation, as a script sends it: no interface marker. */
  const agent = (body: Record<string, unknown>, by = "agent:jarvis") => rawCall(router, "POST", BOARD, { createdBy: by, ...body }, {});
  /** The person, from the board interface. */
  const person = (body: Record<string, unknown>) => call(router, "POST", BOARD, body);
  /** The notes the triage wrote: the notice of a card born without a bar (every agent card here) is another story. */
  const commentsOf = (id: string) => db.query("SELECT author, content, quiet FROM task_comments WHERE task_id = ? AND content NOT LIKE 'Incomplete card:%' ORDER BY created_at").all(id) as Array<{ author: string; content: string; quiet: number | null }>;
  const count = () => (db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

  describe("the board API for an agent or a schedule: an open twin is not a new card", () => {
    test("asking again returns the open card, writes one quiet note on it and opens nothing", async () => {
      const first = await (await agent({ text: TWIN, description: "il primo contesto" }))!.json();
      const resp = (await agent({ text: TWIN_AGAIN, description: "il contesto della seconda richiesta" }, "agent:task-sync"))!;
      expect(resp.status).toBe(200);
      const again = await resp.json();
      expect(again.id).toBe(first.id);
      expect(again.duplicateOf).toBe(first.id);
      expect(again.projectId).toBe(first.projectId);
      expect(count()).toBe(1);
      const notes = commentsOf(first.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ author: "system", quiet: 1 });
      expect(notes[0]!.content).toContain("Stessa richiesta arrivata di nuovo da agent:task-sync");
      expect(notes[0]!.content).toContain(TWIN_AGAIN);
      expect(notes[0]!.content).toContain("il contesto della seconda richiesta");
    });

    test("the same request sent again and again leaves ONE note, not a pile", async () => {
      const first = await (await agent({ text: TWIN }))!.json();
      for (let i = 0; i < 3; i++) await agent({ text: TWIN_AGAIN });
      expect(commentsOf(first.id)).toHaveLength(1);
    });

    test("a schedule is an automation too", async () => {
      const first = await (await agent({ text: TWIN }, "cron:scheduled-card"))!.json();
      const again = await (await agent({ text: TWIN_AGAIN }, "cron:scheduled-card"))!.json();
      expect(again.duplicateOf).toBe(first.id);
      expect(count()).toBe(1);
    });

    test("a caller that names nobody (agent:api) is an automation: the gate holds for it", async () => {
      const first = await (await rawCall(router, "POST", BOARD, { text: TWIN }, {}))!.json();
      const resp = (await rawCall(router, "POST", BOARD, { text: TWIN_AGAIN }, {}))!;
      expect(resp.status).toBe(200);
      expect((await resp.json()).duplicateOf).toBe(first.id);
    });

    test("a card waiting in the queue (todo) is a twin too: it has not started", async () => {
      const first = await (await agent({ text: TWIN }))!.json();
      db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [first.id]);
      const again = await (await agent({ text: TWIN_AGAIN }))!.json();
      expect(again.duplicateOf).toBe(first.id);
    });

    // The callers write on the id they get back (description, due date, status): a started card is not theirs to touch.
    for (const started of ["in_progress", "review"] as const) {
      test(`a twin already ${started} does not absorb the request: a new card, as before`, async () => {
        const first = await (await agent({ text: TWIN }))!.json();
        db.run("UPDATE tasks SET status = ? WHERE id = ?", [started, first.id]);
        const resp = (await agent({ text: TWIN_AGAIN }))!;
        expect(resp.status).toBe(201);
        expect((await resp.json()).duplicateOf).toBeUndefined();
        expect(count()).toBe(2);
      });
    }

    test("a twin that is already done does not hold the new card back", async () => {
      const first = await (await agent({ text: TWIN }))!.json();
      db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first.id]);
      const resp = (await agent({ text: TWIN_AGAIN }))!;
      expect(resp.status).toBe(201);
      expect((await resp.json()).duplicateOf).toBeUndefined();
      expect(count()).toBe(2);
    });

    test("an open twin behind several done ones is still found", async () => {
      const open = await (await agent({ text: TWIN }))!.json();
      for (const dup of ["store: UserMemoryStore.update() + test finale", "store: UserMemoryStore.update() + test finali", "store: UserMemoryStore.update() + test nuovi"]) {
        db.run("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'done', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')", [dup, open.projectId, dup]);
      }
      const again = await (await agent({ text: TWIN_AGAIN }))!.json();
      expect(again.duplicateOf).toBe(open.id);
    });

    test("a person from the board interface keeps the card she asked for, even a twin", async () => {
      await person({ text: TWIN });
      const resp = (await person({ text: TWIN_AGAIN }))!;
      expect(resp.status).toBe(201);
      expect(count()).toBe(2);
    });

    test("the gate is opened on purpose: allowDuplicate or allow_duplicate", async () => {
      await agent({ text: TWIN });
      expect((await agent({ text: TWIN_AGAIN, allowDuplicate: true }))!.status).toBe(201);
      expect((await agent({ text: "store: UserMemoryStore.update() + test dopo", allow_duplicate: true }))!.status).toBe(201);
    });

    test("a step under a parent is not a twin: the steps of a job repeat by trade", async () => {
      const parent = await (await agent({ text: "Il lavoro grosso con tutti i suoi passi" }))!.json();
      await agent({ text: TWIN });
      const step = (await agent({ text: TWIN_AGAIN, parentTaskId: parent.id }))!;
      expect(step.status).toBe(201);
      expect((await step.json()).parentTaskId).toBe(parent.id);
    });

    test("a card of another board is not a twin: each board looks at its own", async () => {
      await agent({ text: TWIN });
      const other = (await rawCall(router, "POST", "/api/boards/pY/tasks", { text: TWIN_AGAIN, createdBy: "agent:jarvis" }, {}))!;
      expect(other.status).toBe(201);
    });

    test("two different jobs are two cards", async () => {
      await agent({ text: TWIN });
      expect((await agent({ text: "Sonda della CPU vera sotto carico" }))!.status).toBe(201);
    });

    test("the open twin is announced to the open views", async () => {
      const first = await (await agent({ text: TWIN }))!.json();
      broadcasts.length = 0;
      await agent({ text: TWIN_AGAIN });
      expect(broadcasts.some((b) => b.type === "task:updated" && b.task?.id === first.id)).toBe(true);
      expect(broadcasts.some((b) => b.type === "task:created")).toBe(false);
    });
  });

  describe("a retry of a creation that worked gets its card, not a 409", () => {
    test("create_task with the same idempotency_key twice: the same card both times", async () => {
      const first = (await call(router, "POST", SESSION, { text: TWIN, idempotency_key: "k-retry-1" }))!;
      expect(first.status).toBe(201);
      const retry = (await call(router, "POST", SESSION, { text: TWIN, idempotency_key: "k-retry-1" }))!;
      expect(retry.status).toBe(201);
      expect((await retry.json()).id).toBe((await first.json()).id);
      expect(count()).toBe(1);
    });

    test("a different key with the same words is still a twin: the gate holds", async () => {
      await call(router, "POST", SESSION, { text: TWIN, idempotency_key: "k-a" });
      const second = (await call(router, "POST", SESSION, { text: TWIN_AGAIN, idempotency_key: "k-b" }))!;
      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe("duplicate");
    });
  });

  describe("a numbered series is born under its milestone", () => {
    const motherOf = (prefix: string) => db.query("SELECT id, status, description, created_by AS by, parent_task_id AS parent, assigned_to AS owner FROM tasks WHERE text = ?").get(prefix) as { id: string; status: string; description: string; by: string | null; parent: string | null; owner: string | null } | null;
    const parentOf = (id: string) => (db.query("SELECT parent_task_id AS p FROM tasks WHERE id = ?").get(id) as { p: string | null }).p;

    test("one card alone is a card: no milestone for a series of one", async () => {
      const first = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      expect(motherOf("Lavori programmati")).toBeNull();
      expect(parentOf(first.id)).toBeNull();
    });

    test("the second member creates the milestone in backlog and both go under it", async () => {
      const first = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      const resp = (await agent({ text: "Lavori programmati 4/8: consegna due" }))!;
      expect(resp.status).toBe(201);
      const second = await resp.json();
      const mother = motherOf("Lavori programmati")!;
      expect(mother).not.toBeNull();
      expect(mother.status).toBe("backlog");
      expect(mother.parent).toBeNull();
      expect(mother.description).toBe("Card contenitore della serie Lavori programmati: si chiude quando i figli sono done. Non spostarla in todo.");
      expect(second.parentTaskId).toBe(mother.id);
      expect(parentOf(first.id)).toBe(mother.id);
      expect(parentOf(second.id)).toBe(mother.id);
    });

    test("the next member joins the milestone that exists: still one milestone", async () => {
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      await agent({ text: "Lavori programmati 4/8: consegna due" });
      const third = await (await agent({ text: "Lavori programmati 5/8: consegna tre" }))!.json();
      const mothers = db.query("SELECT id FROM tasks WHERE text = 'Lavori programmati'").all() as Array<{ id: string }>;
      expect(mothers).toHaveLength(1);
      expect(third.parentTaskId).toBe(mothers[0]!.id);
    });

    test("a milestone somebody already made, with exactly the prefix as its text, is the one the new card joins", async () => {
      const made = await (await person({ text: "Lavori programmati", status: "backlog" }))!.json();
      const first = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      expect(first.parentTaskId).toBe(made.id);
      expect((db.query("SELECT COUNT(*) AS n FROM tasks WHERE text = 'Lavori programmati'").get() as { n: number }).n).toBe(1);
    });

    test("the tag schema works the same: «Due repo T5» and «Due repo T6» are not twins and share a milestone", async () => {
      const first = await (await agent({ text: "Due repo T5: hub generico per gli agenti" }))!.json();
      const resp = (await agent({ text: "Due repo T6: hub generico per gli agenti" }))!;
      expect(resp.status).toBe(201);
      const second = await resp.json();
      const mother = motherOf("Due repo")!;
      expect(parentOf(first.id)).toBe(mother.id);
      expect(second.parentTaskId).toBe(mother.id);
    });

    test("another schema or another prefix is not a sibling", async () => {
      await agent({ text: "Due repo 1/3: setup iniziale" });
      await agent({ text: "Due repo T2: hub generico" });
      await agent({ text: "Altre cose T3: altro" });
      expect(db.query("SELECT 1 FROM tasks WHERE parent_task_id IS NOT NULL").all()).toHaveLength(0);
    });

    test("a sibling that is working stays where its owner looks for it, and does not make a milestone by itself", async () => {
      const busy = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [busy.id]);
      const second = await (await agent({ text: "Lavori programmati 4/8: consegna due" }))!.json();
      expect(motherOf("Lavori programmati")).toBeNull();
      expect(parentOf(busy.id)).toBeNull();
      expect(second.parentTaskId).toBeNull();
    });

    test("a sibling that is working is left out, the inert one goes under the milestone", async () => {
      const busy = await (await agent({ text: "Lavori programmati 2/8: consegna zero" }))!.json();
      db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [busy.id]);
      const calm = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      const third = await (await agent({ text: "Lavori programmati 4/8: consegna due" }))!.json();
      const mother = motherOf("Lavori programmati")!;
      expect(parentOf(busy.id)).toBeNull();
      expect(parentOf(calm.id)).toBe(mother.id);
      expect(third.parentTaskId).toBe(mother.id);
    });

    test("the siblings that moved are told why, once", async () => {
      const first = await (await agent({ text: "Lavori programmati 3/8: consegna uno" }))!.json();
      await agent({ text: "Lavori programmati 4/8: consegna due" });
      const notes = commentsOf(first.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.content).toContain("Raggruppata sotto «Lavori programmati»");
    });

    test("a card born in todo is never nested: a subtask is not dispatched on its own", async () => {
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      const todo = await (await agent({ text: "Lavori programmati 4/8: consegna due", status: "todo" }))!.json();
      expect(todo.parentTaskId).toBeNull();
      expect(motherOf("Lavori programmati")).toBeNull();
    });

    test("a card that names its parent keeps it: no milestone is made behind its back", async () => {
      const parent = await (await agent({ text: "Il lavoro grosso con tutti i suoi passi" }))!.json();
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      const step = await (await agent({ text: "Lavori programmati 4/8: consegna due", parentTaskId: parent.id }))!.json();
      expect(step.parentTaskId).toBe(parent.id);
      expect(motherOf("Lavori programmati")).toBeNull();
    });

    test("a person from the board interface is not grouped: she opens the card she wants", async () => {
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      const mine = await (await person({ text: "Lavori programmati 4/8: consegna due" }))!.json();
      expect(mine.parentTaskId).toBeNull();
      expect(motherOf("Lavori programmati")).toBeNull();
    });

    test("the milestone is never dispatched: it is a container, born in backlog, with nobody on it", async () => {
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      await agent({ text: "Lavori programmati 4/8: consegna due" });
      const mother = motherOf("Lavori programmati")!;
      expect(mother.status).toBe("backlog");
      expect(mother.owner).toBeNull();
      // Not an agent card: nobody is told that «an agent opened it without a bar» or that it sat unowned.
      expect(mother.by).toBeNull();
    });

    test("the milestone and the moves reach the open views", async () => {
      await agent({ text: "Lavori programmati 3/8: consegna uno" });
      broadcasts.length = 0;
      await agent({ text: "Lavori programmati 4/8: consegna due" });
      const created = broadcasts.filter((b) => b.type === "task:created").map((b) => b.task.text);
      expect(created).toContain("Lavori programmati");
      expect(broadcasts.filter((b) => b.type === "task:updated").length).toBeGreaterThan(0);
    });

    test("create_task (MCP) groups the series the same way", async () => {
      const first = await (await call(router, "POST", SESSION, { text: "Due repo T5: hub generico per gli agenti" }))!.json();
      const resp = (await call(router, "POST", SESSION, { text: "Due repo T6: hub generico per gli agenti" }))!;
      expect(resp.status).toBe(201);
      const second = await resp.json();
      const mother = motherOf("Due repo")!;
      expect(mother).not.toBeNull();
      expect(parentOf(first.id)).toBe(mother.id);
      expect(second.parentTaskId).toBe(mother.id);
    });

    test("create_task with a parent_task_id is never regrouped", async () => {
      const parent = await (await call(router, "POST", SESSION, { text: "Il lavoro grosso con tutti i suoi passi" }))!.json();
      await call(router, "POST", SESSION, { text: "Due repo T5: hub generico per gli agenti" });
      const step = await (await call(router, "POST", SESSION, { text: "Due repo T6: hub generico per gli agenti", parent_task_id: parent.id }))!.json();
      expect(step.parentTaskId).toBe(parent.id);
      expect(motherOf("Due repo")).toBeNull();
    });
  });
});
