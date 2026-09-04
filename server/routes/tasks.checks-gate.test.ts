/**
 * THE PRE-REVIEW CHECKS GATE, on both gestures that close a card.  @covers LAND-05
 *
 * The gate lived inside `if (decision === "approve")` in `routes/tasks.ts`:
 * `POST …/land` queued the merge without ever looking at `checks_state`. But
 * landing CONTAINS the acceptance and puts the branch on main on top of it, so
 * the less reversible of the two gestures was the only one with no gate. On a
 * review card with a branch it was also the GREEN button, and the quick reply
 * «Landa su main» reached the same merge through a `reject`, which is the
 * gate's service door.
 *
 * It is not a ban: `force` overrides it, and that is the point. What the gate
 * buys is that the exception is a CHOICE (the button says «comunque») instead
 * of the silent default.
 *
 * Its own file and not `tasks.landing.test.ts`: that one is about approve and
 * land being two different things, it was sitting on the 800-line threshold,
 * and this is a different question anyway.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { LAND_ACTION_LABEL } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("the pre-review checks gate", () => {
  let db: Database; let broadcasts: any[]; let merges: string[]; let router: any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; merges = [];
    const autoMerge = {
      tryMerge: async (taskId: string) => { merges.push(taskId); return { status: "nothing" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async () => {},
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge });
  });

  /** A delivered card in review, with an agent tab behind it. */
  async function reviewTask(): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  /** The land is fire-and-forget: let the microtasks drain before reading. */
  const flushLand = () => new Promise((r) => setTimeout(r, 0));

  /** Records a red the way the pre-review gate would write it on a delivery. */
  const markRed = (id: string) =>
    db.prepare("UPDATE tasks SET checks_state = 'fail', checks_json = ? WHERE id = ?")
      .run(JSON.stringify([{ name: "lint", cmd: "bun run lint", ok: false, code: 1, ms: 10, timedOut: false, tail: "1 error" }]), id);

  test("POST /land coi checks ROSSI: 409, e nessuna fusione parte", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    markRed(id);
    const blocked = (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!;
    expect(blocked.status).toBe(409);
    const err = await blocked.json();
    expect(err.code).toBe("checks_failed");
    expect(err.error).toContain("lint");        // it says WHICH check
    expect(err.error).not.toContain("force");   // the API's remedy is not the one a card reader has
    await flushLand();
    expect(merges).toEqual([]);                 // main was never touched
  });

  test("…e `force` e' la scelta esplicita dell'umano: il land parte", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    markRed(id);
    const ok = (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, { force: true }))!;
    expect(ok.status).toBe(202);
    await flushLand();
    expect(merges).toEqual([id]);
  });

  test("la porta di servizio: la quick reply «Landa su main» passa dallo stesso cancello", async () => {
    // It arrives as a `reject` carrying the button's text, so it never met the
    // approve `if`: the same merge, with nobody looking at the checks.
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    markRed(id);
    const blocked = (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL }))!;
    expect(blocked.status).toBe(409);
    await flushLand();
    expect(merges).toEqual([]);
  });

  test("coi checks VERDI il land non chiede nessun force", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET checks_state = 'pass', delivery_branch = 'topics/x' WHERE id = ?").run(id);
    const ok = (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!;
    expect(ok.status).toBe(202);
    await flushLand();
    expect(merges).toEqual([id]);
  });
});
